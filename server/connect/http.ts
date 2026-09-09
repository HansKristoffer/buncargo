import { record, text } from "../../src/core/connect/protocol";
import { type ConnectionDirectory, DirectoryError } from "./directory";
/** Internal callbacks are served on a separate loopback listener, never on the public API. */
export function frpHook(
	directory: ConnectionDirectory,
	op: string,
	value: unknown,
) {
	try {
		const c = record(record(value).content),
			user = op === "Login" ? c : record(c.user),
			metas = record(user.metas);
		if (!text(metas.credential)) throw new Error("Missing credential");
		const session = directory.session(metas.credential),
			p = session.publication;
		if (user.user !== p.id) throw new Error("Wrong namespace");
		if (op === "NewProxy") {
			if (session.role !== "publisher")
				throw new Error("Visitors cannot publish");
			const a = p.assignments.find((a) => c.proxy_name === `${p.id}.${a.id}`);
			if (!a || c.proxy_type !== (a.protocol === "http" ? "http" : "stcp"))
				throw new Error("Unallocated proxy");
			const target = p.run.targets.find((t) => t.id === a.targetId);
			// Replace routing fields, rather than trusting optional client fields we did not validate.
			return {
				unchange: false,
				content: {
					user: c.user,
					proxy_name: c.proxy_name,
					proxy_type: c.proxy_type,
					use_encryption: false,
					use_compression: false,
					...(a.protocol === "http"
						? {
								subdomain: a.subdomain,
								host_header_rewrite: `localhost:${target?.port}`,
							}
						: { sk: a.secretKey, allow_users: [p.id] }),
				},
			};
		}
		if (!["Login", "Ping", "NewWorkConn"].includes(op))
			throw new Error("Unsupported callback");
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
		const url = new URL(request.url),
			path = url.pathname;
		const json = (value: unknown, status = 200) =>
			Response.json(value, {
				status,
				headers: {
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				},
			});
		try {
			if (path === "/healthz" && request.method === "GET")
				return json({ ok: true, version: 1 });
			if (request.headers.has("origin"))
				throw new DirectoryError("Browser API access is disabled", 403);
			const now = Date.now();
			if (buckets.size > 10000)
				for (const [key, b] of buckets) if (b.reset < now) buckets.delete(key);
			const bucket = buckets.get(ip);
			if (bucket && bucket.reset > now) {
				if (++bucket.count > 300)
					throw new DirectoryError("Rate limit exceeded", 429);
			} else buckets.set(ip, { count: 1, reset: now + 60_000 });
			const owner =
				request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
			let body: Record<string, unknown> = {};
			if (["POST", "PUT"].includes(request.method)) {
				if (Number(request.headers.get("content-length")) > 131072)
					throw new DirectoryError("Request too large", 413);
				const reader = request.body?.getReader();
				let size = 0;
				const chunks: Uint8Array[] = [];
				if (reader)
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							size += value.length;
							if (size > 131072)
								throw new DirectoryError("Request too large", 413);
							chunks.push(value);
						}
					} finally {
						await reader.cancel();
					}
				body = record(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
			}
			const result = directory.store.atomic(() => {
				if (path === "/v1/receivers" && request.method === "POST")
					return directory.createReceiver();
				if (path === "/v1/receiver" && request.method === "DELETE") {
					directory.deleteReceiver(owner);
					return { ok: true };
				}
				if (path === "/v1/receiver/token" && request.method === "POST")
					return directory.rotate(owner);
				if (path === "/v1/receiver/runs" && request.method === "GET")
					return directory.list(owner);
				const grant = /^\/v1\/receiver\/grants\/([a-f0-9]{32})$/.exec(path);
				if (grant && request.method === "DELETE")
					return directory.revoke(owner, grant[1]);
				if (path === "/v1/publications" && request.method === "POST") {
					if (
						!Array.isArray(body.tokens) ||
						!body.tokens.every((t) => typeof t === "string") ||
						typeof body.credential !== "string"
					)
						throw new DirectoryError("Invalid publication request");
					return directory.register(body.tokens, body.run, body.credential);
				}
				const publication = /^\/v1\/publications\/([a-f0-9]{32})$/.exec(path);
				if (publication && request.method === "PUT")
					return directory.update(
						publication[1],
						owner,
						body.run,
						Array.isArray(body.confirmed)
							? body.confirmed.filter((v): v is string => typeof v === "string")
							: [],
					);
				if (publication && request.method === "DELETE") {
					directory.retire(publication[1], owner);
					return { ok: true };
				}
				const visitor = /^\/v1\/targets\/([^/]+)\/visitor$/.exec(path);
				if (visitor && request.method === "POST")
					return directory.visitor(owner, decodeURIComponent(visitor[1]));
				if (path === "/v1/visitor/renew" && request.method === "POST")
					return directory.renewVisitor(owner);
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
