/**
 * Lightweight loopback HTTP / HTTPS `CONNECT` egress proxy owned by one run.
 *
 * Binds `127.0.0.1:0` (ephemeral OS port) so it never takes a slot from the
 * checkout's port block. In `"block"` mode, non-allowlisted outbound requests
 * fail fast with HTTP 403 and a clear message; in `"warn"` mode, they are
 * reported and forwarded.
 */

import {
	createServer,
	request as httpRequest,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { compileAllowRules, isLoopbackHost, normalizeHost } from "./rules";

export interface BlockedEgressEvent {
	readonly method: string;
	readonly host: string;
	readonly port: number;
	readonly mode: "block" | "warn";
}

export interface EgressGuardProxy {
	readonly port: number;
	readonly url: string;
	/** Let these exact hostnames through from now on (`allowHostsOf`, resolved per process). */
	allowHosts(hosts: readonly string[]): void;
	close(): Promise<void>;
}

interface StartEgressGuardProxyOptions {
	readonly allow: readonly string[];
	readonly mode: "block" | "warn";
	readonly onBlocked?: (event: BlockedEgressEvent) => void;
}

function parseStrictPort(raw: string): number | undefined {
	if (!/^\d+$/.test(raw)) return undefined;
	const port = Number.parseInt(raw, 10);
	return port >= 1 && port <= 65535 ? port : undefined;
}

/** Parse a `CONNECT` authority (`host:port` or `[::1]:443`) into host + port. */
export function parseConnectAuthority(
	authority: string,
): { host: string; port: number } | undefined {
	const trimmed = authority.trim();
	if (!trimmed) return undefined;

	if (trimmed.startsWith("[")) {
		const close = trimmed.indexOf("]");
		if (close === -1) return undefined;
		const host = trimmed.slice(1, close);
		if (!host) return undefined;
		const rest = trimmed.slice(close + 1);
		if (rest === "") return { host, port: 443 };
		if (!rest.startsWith(":")) return undefined;
		const port = parseStrictPort(rest.slice(1));
		return port !== undefined ? { host, port } : undefined;
	}

	const colon = trimmed.lastIndexOf(":");
	if (colon === -1) return { host: trimmed, port: 443 };
	const host = trimmed.slice(0, colon);
	const port = parseStrictPort(trimmed.slice(colon + 1));
	if (!host || port === undefined) return undefined;
	return { host, port };
}

function blockedBody(host: string, port: number): string {
	return `Blocked by buncargo egressGuard: outbound connection to ${host}:${port} is not allowlisted. Add "${host}" to egressGuard.allow in dev.config.ts to permit it.\n`;
}

/** One-line summary of a blocked or warn-mode egress event for logs and warnings. */
export function formatBlockedEgress(event: BlockedEgressEvent): string {
	const action = event.mode === "block" ? "Blocked" : "Allowed (warn)";
	return `${action} outbound ${event.method} to ${event.host}:${event.port} (add "${event.host}" to egressGuard.allow to permit)`;
}

/** Start the loopback egress proxy on `127.0.0.1:0`. */
export async function startEgressGuardProxy(
	options: StartEgressGuardProxyOptions,
): Promise<EgressGuardProxy> {
	const sockets = new Set<Socket>();
	// Hosts learned once the guarded processes' env is final (`allowHostsOf`):
	// exact names, kept out of `allow` so none is ever read as a pattern or port.
	const learned = new Set<string>();
	const matchesAllow = compileAllowRules(options.allow);
	const isAllowed = (host: string, port: number) =>
		learned.has(normalizeHost(host)) || matchesAllow(host, port);
	let boundPort = 0;
	const trackSocket = (socket: Socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	};

	const server: Server = createServer(
		(req: IncomingMessage, res: ServerResponse) => {
			let target: URL;
			try {
				const rawUrl = req.url ?? "";
				if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl)) {
					target = new URL(rawUrl);
				} else {
					const hostHeader = req.headers.host?.trim();
					if (!hostHeader) {
						res.writeHead(400, { "content-type": "text/plain" });
						res.end("Missing Host header on proxy request\n");
						return;
					}
					target = new URL(`http://${hostHeader}${rawUrl}`);
				}
			} catch {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("Bad proxy request URL\n");
				return;
			}

			if (target.protocol !== "http:" && target.protocol !== "https:") {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end(`Unsupported proxy scheme: ${target.protocol}\n`);
				return;
			}

			const host = normalizeHost(target.hostname);
			const port = target.port
				? parseStrictPort(target.port)
				: target.protocol === "https:"
					? 443
					: 80;
			if (port === undefined) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("Invalid proxy target port\n");
				return;
			}

			// Refuse requests targeting this proxy's own port to prevent recursion.
			if (isLoopbackHost(host) && port === boundPort) {
				res.writeHead(400, { "content-type": "text/plain" });
				res.end("Refusing self-proxied request to buncargo egressGuard\n");
				return;
			}

			const allowed = isAllowed(host, port);
			if (!allowed) {
				options.onBlocked?.({
					method: req.method ?? "GET",
					host,
					port,
					mode: options.mode,
				});
				if (options.mode === "block") {
					res.writeHead(403, {
						"content-type": "text/plain",
						"x-buncargo-egress-blocked": "1",
					});
					res.end(blockedBody(host, port));
					return;
				}
			}

			const headers = { ...req.headers };
			delete headers["proxy-connection"];
			const makeRequest =
				target.protocol === "https:" ? httpsRequest : httpRequest;
			const upstream = makeRequest(
				{
					hostname: host,
					port,
					method: req.method,
					path: `${target.pathname}${target.search}`,
					headers,
				},
				(upstreamRes) => {
					if (res.destroyed || res.writableEnded) {
						upstreamRes.resume();
						return;
					}
					upstreamRes.on("error", () => {
						if (!res.destroyed) res.destroy();
					});
					res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
					upstreamRes.pipe(res);
				},
			);
			const abortUpstream = () => {
				if (!res.writableEnded) upstream.destroy();
			};
			req.on("aborted", abortUpstream);
			req.on("error", abortUpstream);
			res.on("close", abortUpstream);
			upstream.on("error", (error) => {
				if (res.destroyed || res.writableEnded) return;
				if (res.headersSent) {
					res.destroy(error);
					return;
				}
				res.writeHead(502, { "content-type": "text/plain" });
				res.end(`Proxy upstream error: ${error.message}\n`);
			});
			req.pipe(upstream);
		},
	);

	server.on("connection", trackSocket);
	server.on("clientError", (_error, socket) => {
		if (!socket.destroyed) {
			socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		}
	});

	server.on("connect", (req: IncomingMessage, clientSocket: Socket, head) => {
		const target = parseConnectAuthority(req.url ?? "");
		if (!target) {
			clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}
		if (isLoopbackHost(target.host) && target.port === boundPort) {
			clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
			return;
		}

		const allowed = isAllowed(target.host, target.port);
		if (!allowed) {
			options.onBlocked?.({
				method: "CONNECT",
				host: target.host,
				port: target.port,
				mode: options.mode,
			});
			if (options.mode === "block") {
				const body = blockedBody(target.host, target.port);
				clientSocket.end(
					`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Buncargo-Egress-Blocked: 1\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
				);
				return;
			}
		}

		let established = false;
		const upstream = netConnect(target.port, normalizeHost(target.host), () => {
			if (clientSocket.destroyed) {
				upstream.destroy();
				return;
			}
			upstream.setTimeout(0);
			established = true;
			clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length > 0) upstream.write(head);
			upstream.pipe(clientSocket);
			clientSocket.pipe(upstream);
		});
		upstream.setTimeout(30_000, () => {
			if (!established) upstream.destroy(new Error("Upstream connect timeout"));
		});
		trackSocket(upstream);

		upstream.on("error", () => {
			if (clientSocket.destroyed) return;
			if (!established) {
				clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			} else {
				clientSocket.destroy();
			}
		});
		upstream.once("close", () => {
			if (!clientSocket.destroyed) clientSocket.destroy();
		});
		const closeUpstream = () => upstream.destroy();
		clientSocket.on("error", closeUpstream);
		clientSocket.on("close", closeUpstream);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	// Absorb post-listen socket/server errors so one broken client never crashes the run.
	server.on("error", () => {});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Egress guard proxy failed to bind an ephemeral port.");
	}

	boundPort = address.port;
	let closed = false;

	return {
		port: boundPort,
		url: `http://127.0.0.1:${boundPort}`,
		allowHosts: (hosts) => {
			for (const host of hosts) {
				const normalized = normalizeHost(host);
				if (normalized) learned.add(normalized);
			}
		},
		close: async () => {
			if (closed) return;
			closed = true;
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}
