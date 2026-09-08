import { once } from "node:events";
import {
	Agent,
	request as httpRequest,
	createServer as httpServer,
	type IncomingMessage,
} from "node:http";
import { type Socket, createServer as tcpServer } from "node:net";
import type { Duplex } from "node:stream";
import { makeSecret, type RemoteTarget } from "../protocol";
import { openStream } from "./client-stream";
export interface Forward {
	endpoint: string;
	port: number;
	url: string;
	target: RemoteTarget;
	browserCookie?: string;
	close(): Promise<void>;
}
/** Private HTTP cookies are per listener; device credentials never enter the browser. */
export async function localForward(
	endpoint: string,
	target: RemoteTarget,
	access: () => Promise<string>,
	browser?: { origins: ReadonlySet<string>; cookies: () => string[] },
): Promise<Forward> {
	const streams = new Set<Duplex>();
	const sockets = new Set<Duplex>();
	const open = async () => {
		const stream = await openStream(endpoint, target.id, access);
		streams.add(stream);
		stream.on("error", () => {});
		stream.on("close", () => streams.delete(stream));
		return stream;
	};
	if (target.protocol === "tcp") {
		const server = tcpServer({ allowHalfOpen: true }, (socket) => {
			sockets.add(socket);
			socket.on("close", () => sockets.delete(socket));
			socket.on("error", () => {});
			socket.pause();
			void open()
				.then((stream) => {
					if (socket.destroyed) {
						stream.destroy();
						return;
					}
					stream.on("close", () => socket.destroy());
					socket.on("close", () => stream.destroy());
					socket.pipe(stream).pipe(socket);
					socket.resume();
				})
				.catch(() => socket.destroy());
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const port = (server.address() as { port: number }).port;
		return {
			endpoint,
			port,
			url: `tcp://127.0.0.1:${port}`,
			target,
			close: async () => {
				for (const s of streams) s.destroy();
				for (const s of sockets) s.destroy();
				server.close();
			},
		};
	}
	const bootstrap = makeSecret(),
		cookie = makeSecret();
	let port = 0;
	const cookieName = () => `bc_connect_${port}`;
	const origin = () => `http://127.0.0.1:${port}`;
	function allowed(req: IncomingMessage): boolean {
		if (req.headers.host !== `127.0.0.1:${port}`) return false;
		if (
			req.headers.origin &&
			req.headers.origin !== origin() &&
			!browser?.origins.has(req.headers.origin)
		)
			return false;
		if (
			req.headers["sec-fetch-site"] &&
			!["same-origin", "none"].includes(
				String(req.headers["sec-fetch-site"]),
			) &&
			!(req.headers.origin && browser?.origins.has(req.headers.origin))
		)
			return false;
		return (
			req.headers.cookie
				?.split(";")
				.some((c) => c.trim() === `${cookieName()}=${cookie}`) ?? false
		);
	}
	function headers(req: IncomingMessage) {
		const h = { ...req.headers };
		delete h["proxy-authorization"];
		h.cookie = h.cookie
			?.split(";")
			.filter((c) => !c.trim().startsWith("bc_connect_"))
			.join(";");
		// Host the origin expects is supplied by its own dev server; localhost works with Vite defaults.
		h.host = "localhost";
		h["x-forwarded-host"] = req.headers.host;
		h["x-forwarded-proto"] = "http";
		return h;
	}
	const agent = new Agent({ keepAlive: false });
	agent.createConnection = (_options, callback) => {
		void open()
			.then((stream) => callback?.(null, stream as unknown as Socket))
			.catch((error) => callback?.(error, null as unknown as Socket));
		return undefined as unknown as Socket;
	};
	const server = httpServer((req, res) => {
		const url = new URL(req.url ?? "/", origin());
		const trustedOrigin =
			req.headers.origin && browser?.origins.has(req.headers.origin);
		if (trustedOrigin && req.headers.host === `127.0.0.1:${port}`) {
			res.setHeader(
				"access-control-allow-origin",
				req.headers.origin as string,
			);
			res.setHeader("access-control-allow-credentials", "true");
			if (req.method === "OPTIONS") {
				res.setHeader(
					"access-control-allow-methods",
					"GET, POST, PUT, PATCH, DELETE, OPTIONS",
				);
				res.setHeader(
					"access-control-allow-headers",
					req.headers["access-control-request-headers"] ??
						"content-type, authorization",
				);
				res.writeHead(204);
				res.end();
				return;
			}
		}
		if (
			req.headers.host === `127.0.0.1:${port}` &&
			url.pathname === "/__buncargo_open" &&
			url.searchParams.get("key") === bootstrap
		) {
			res.writeHead(303, {
				"set-cookie": [
					`${cookieName()}=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
					...(browser?.cookies() ?? []),
				],
				location: "/",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
			res.end();
			return;
		}
		if (!allowed(req)) {
			res.writeHead(403);
			res.end("Open this service from BuncargoBar");
			return;
		}
		const upstream = httpRequest(
			{
				hostname: "localhost",
				port: 80,
				path: req.url,
				method: req.method,
				headers: headers(req),
				agent,
			},
			(response) => {
				const h = { ...response.headers };
				if (trustedOrigin) {
					h["access-control-allow-origin"] = req.headers.origin;
					h["access-control-allow-credentials"] = "true";
				}
				const location = h.location;
				if (
					location &&
					/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(location)
				) {
					const parsed = new URL(location);
					h.location = `${origin()}${parsed.pathname}${parsed.search}${parsed.hash}`;
				}
				res.writeHead(response.statusCode ?? 502, h);
				response.pipe(res);
			},
		);
		upstream.on("error", () => {
			if (!res.headersSent) res.writeHead(502);
			res.end("Remote service unavailable");
		});
		res.on("close", () => upstream.destroy());
		req.pipe(upstream);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (req, socket, head) => {
		if (!allowed(req)) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		socket.pause();
		void open()
			.then((stream) => {
				if (socket.destroyed) {
					stream.destroy();
					return;
				}
				const h = headers(req);
				const lines = Object.entries(h)
					.filter(([, value]) => value !== undefined)
					.flatMap(([name, value]) =>
						(Array.isArray(value) ? value : [value]).map(
							(item) => `${name}: ${item}`,
						),
					);
				stream.write(
					`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`,
				);
				if (head.length) stream.write(head);
				socket.on("close", () => stream.destroy());
				stream.on("close", () => socket.destroy());
				socket.pipe(stream).pipe(socket);
				socket.resume();
			})
			.catch(() => socket.destroy());
	});
	server.requestTimeout = 0;
	server.setTimeout(0);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	port = (server.address() as { port: number }).port;
	return {
		endpoint,
		port,
		url: `${origin()}/__buncargo_open?key=${bootstrap}`,
		target,
		browserCookie: `${cookieName()}=${cookie}; HttpOnly; SameSite=Strict; Path=/`,
		close: async () => {
			agent.destroy();
			for (const s of streams) s.destroy();
			for (const s of sockets) s.destroy();
			server.close();
		},
	};
}
