import { readBoundedBody } from "../../src/core/connect/json";
import { record, text } from "../../src/core/connect/protocol";
import { type ConnectionDirectory, DirectoryError } from "./directory";

const MAX_REQUEST_BYTES = 128 * 1024;

/** Internal callbacks are served on a separate loopback listener, never on the public API. */
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
			if (request.headers.has("origin")) {
				throw new DirectoryError("Browser API access is disabled", 403);
			}
			const now = Date.now();
			if (buckets.size > 10000) {
				for (const [key, bucketEntry] of buckets) {
					if (bucketEntry.reset < now) {
						buckets.delete(key);
					}
				}
			}
			const bucket = buckets.get(ip);
			if (bucket && bucket.reset > now) {
				if (++bucket.count > 300) {
					throw new DirectoryError("Rate limit exceeded", 429);
				}
			} else {
				buckets.set(ip, { count: 1, reset: now + 60_000 });
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
							? body.confirmed.filter((v): v is string => typeof v === "string")
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
