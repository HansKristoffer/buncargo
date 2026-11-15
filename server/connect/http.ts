import { isString } from "hanzio";
import { readBoundedBody } from "../../src/core/connect/json";
import { record, text } from "../../src/core/connect/protocol";
import { type ConnectionDirectory, DirectoryError } from "./directory";

const MAX_REQUEST_BYTES = 128 * 1024;

// Per client address: 300 requests per minute.
const RATE_LIMIT_REQUESTS = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Above this many tracked addresses, expired buckets are swept so the map cannot grow without bound.
const RATE_LIMIT_SWEEP_THRESHOLD = 10000;

/**
 * Answers an frps server-plugin callback (`Login`, `NewProxy`, `Ping`, `NewWorkConn`). Internal
 * callbacks are served on a separate loopback listener, never on the public API. Any malformed
 * or unauthorized request is rejected, so the relay fails closed.
 */
export function frpHook(
	directory: ConnectionDirectory,
	op: string,
	value: unknown,
) {
	try {
		const content = record(record(value).content);
		const user = op === "Login" ? content : record(content.user);
		const metas = record(user.metas);
		if (!text(metas.credential)) {
			throw new Error("Missing credential");
		}

		const session = directory.session(metas.credential);
		const publication = session.publication;

		// A client may only act inside the namespace of the publication its credential belongs to.
		if (user.user !== publication.id) {
			throw new Error("Wrong namespace");
		}

		if (op === "NewProxy") {
			if (session.role !== "publisher") {
				throw new Error("Visitors cannot publish");
			}

			const assignment = publication.assignments.find(
				(assignment) =>
					content.proxy_name === `${publication.id}.${assignment.id}`,
			);
			if (
				!assignment ||
				content.proxy_type !==
					(assignment.protocol === "http" ? "http" : "stcp")
			) {
				throw new Error("Unallocated proxy");
			}

			const target = publication.run.targets.find(
				(t) => t.id === assignment.targetId,
			);

			// Replace routing fields, rather than trusting optional client fields we did not validate.
			return {
				unchange: false,
				content: {
					user: content.user,
					proxy_name: content.proxy_name,
					proxy_type: content.proxy_type,
					use_encryption: false,
					// Match the publisher's framing; STCP visitors keep their own transport policy.
					use_compression:
						assignment.protocol === "http" && content.use_compression === true,
					...(assignment.protocol === "http"
						? {
								subdomain: assignment.subdomain,
								host_header_rewrite: `localhost:${target?.port}`,
							}
						: { sk: assignment.secretKey, allow_users: [publication.id] }),
				},
			};
		}

		if (!["Login", "Ping", "NewWorkConn"].includes(op)) {
			throw new Error("Unsupported callback");
		}
		return { unchange: true };
	} catch {
		// Every failure above, including a body that is not the expected shape, means no access.
		return {
			reject: true,
			reject_reason: "Connection session is not authorized",
		};
	}
}

export function createAPI(directory: ConnectionDirectory) {
	const buckets = new Map<string, { count: number; reset: number }>();

	return async (request: Request, ip = "unknown"): Promise<Response> => {
		const url = new URL(request.url);
		const path = url.pathname;

		const json = (value: unknown, status = 200) =>
			Response.json(value, {
				status,
				headers: {
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				},
			});

		try {
			if (path === "/healthz" && request.method === "GET") {
				return json({ ok: true, version: 1 });
			}

			// Browsers are refused outright: a request carrying an Origin header came from a web page.
			if (request.headers.has("origin")) {
				throw new DirectoryError("Browser API access is disabled", 403);
			}

			const now = Date.now();
			if (buckets.size > RATE_LIMIT_SWEEP_THRESHOLD) {
				for (const [key, bucketEntry] of buckets) {
					if (bucketEntry.reset < now) {
						buckets.delete(key);
					}
				}
			}

			const bucket = buckets.get(ip);
			if (bucket && bucket.reset > now) {
				if (++bucket.count > RATE_LIMIT_REQUESTS) {
					throw new DirectoryError("Rate limit exceeded", 429);
				}
			} else {
				buckets.set(ip, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS });
			}

			const owner =
				request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

			let body: Record<string, unknown> = {};
			if (["POST", "PUT"].includes(request.method)) {
				if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) {
					throw new DirectoryError("Request too large", 413);
				}
				const bytes = await readBoundedBody(
					request.body,
					MAX_REQUEST_BYTES,
					new DirectoryError("Request too large", 413),
				);
				body = record(JSON.parse(bytes.toString() || "{}"));
			}

			// One transaction per request, so a failed request leaves no partial writes.
			const result = directory.store.atomic(() => {
				if (path === "/v1/receivers" && request.method === "POST") {
					return directory.createReceiver();
				}
				if (path === "/v1/receiver" && request.method === "DELETE") {
					directory.deleteReceiver(owner);
					return { ok: true };
				}
				if (path === "/v1/receiver/token" && request.method === "POST") {
					return directory.rotate(owner);
				}
				if (path === "/v1/receiver/runs" && request.method === "GET") {
					return directory.list(owner);
				}
				const grant = /^\/v1\/receiver\/grants\/([a-f0-9]{32})$/.exec(path);
				if (grant && request.method === "DELETE") {
					return directory.revoke(owner, grant[1]);
				}
				if (path === "/v1/publications" && request.method === "POST") {
					if (
						!Array.isArray(body.tokens) ||
						!body.tokens.every((t) => typeof t === "string") ||
						typeof body.credential !== "string"
					) {
						throw new DirectoryError("Invalid publication request");
					}
					return directory.register(body.tokens, body.run, body.credential);
				}
				const publication = /^\/v1\/publications\/([a-f0-9]{32})$/.exec(path);
				if (publication && request.method === "PUT") {
					return directory.update(
						publication[1],
						owner,
						body.run,
						Array.isArray(body.confirmed)
							? body.confirmed.filter(isString)
							: [],
					);
				}
				if (publication && request.method === "DELETE") {
					directory.retire(publication[1], owner);
					return { ok: true };
				}
				const visitor = /^\/v1\/targets\/([^/]+)\/visitor$/.exec(path);
				if (visitor && request.method === "POST") {
					return directory.visitor(owner, decodeURIComponent(visitor[1]));
				}
				if (path === "/v1/visitor/renew" && request.method === "POST") {
					return directory.renewVisitor(owner);
				}
				throw new DirectoryError("Not found", 404);
			});

			return json(result);
		} catch (error) {
			// Directory errors carry a status meant for the client; anything else, such as bad JSON, is a 400.
			return json(
				{
					error:
						error instanceof DirectoryError ? error.message : "Invalid request",
				},
				error instanceof DirectoryError ? error.status : 400,
			);
		}
	};
}
