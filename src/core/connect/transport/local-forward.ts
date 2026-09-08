import {
	Agent,
	request as httpRequest,
	createServer as httpServer,
} from "node:http";
import { connect, type Server, createServer as tcpServer } from "node:net";
import type { RemoteTarget } from "../protocol";
import { tailcatForward } from "../tailcat/forward";
import { type BrowserPeers, browserAccess } from "./browser-access";
import { ForwardSockets, listenLoopback } from "./sockets";

export interface Forward {
	endpoint: string;
	port: number;
	url: string;
	target: RemoteTarget;
	browserCookie?: string;
	readonly closed: boolean;
	close(): Promise<void>;
}

/** One Tailcat client and loopback listener per target; every exit path releases both. */
export async function localForward(
	endpoint: string,
	target: RemoteTarget,
	browser?: BrowserPeers,
): Promise<Forward> {
	const tunnel = await tailcatForward(endpoint, target.port);
	const sockets = new ForwardSockets();
	let server: Server | undefined;
	let agent: Agent | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			agent?.destroy();
			sockets.destroy();
			server?.close();
			await tunnel.close();
		})();
		return closing;
	};
	void tunnel.exited.then(close).catch(() => {});
	const open = () =>
		sockets.track(
			connect({
				host: "127.0.0.1",
				port: tunnel.port,
				allowHalfOpen: true,
			}),
		);

	try {
		if (target.protocol === "tcp") {
			server = tcpServer({ allowHalfOpen: true }, (socket) => {
				sockets.track(socket);
				sockets.bridge(socket, open());
			});
			const port = await listenLoopback(server);
			if (closing) throw new Error("Tailcat disconnected during startup");
			return {
				endpoint,
				port,
				url: `tcp://127.0.0.1:${port}`,
				target,
				close,
				get closed() {
					return closing !== undefined;
				},
			};
		}

		let port = 0;
		const access = browserAccess(() => port, browser);
		agent = new Agent({ keepAlive: true, maxSockets: 32 });
		const http = httpServer((req, res) => {
			if (access.handle(req, res)) return;
			const trustedOrigin = access.isTrustedOrigin(req);
			const upstream = httpRequest(
				{
					hostname: "127.0.0.1",
					port: tunnel.port,
					path: req.url,
					method: req.method,
					headers: access.upstreamHeaders(req),
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
						h.location = `${access.origin()}${parsed.pathname}${parsed.search}${parsed.hash}`;
					}
					res.writeHead(response.statusCode ?? 502, h);
					res.flushHeaders();
					response.pipe(res);
				},
			);
			upstream.on("error", () => {
				if (res.headersSent) {
					res.destroy();
					return;
				}
				res.writeHead(502);
				res.end("Remote service unavailable");
			});
			res.on("close", () => upstream.destroy());
			req.pipe(upstream);
		});
		server = http;
		http.on("connection", (socket) => sockets.track(socket));
		http.on("upgrade", (req, socket, head) => {
			if (!access.allowed(req)) {
				socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
				return;
			}
			const stream = open();
			const lines = Object.entries(access.upstreamHeaders(req))
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
			sockets.bridge(socket, stream);
		});
		// SSE and HMR may remain quiet indefinitely; application traffic owns its timeouts.
		http.requestTimeout = 0;
		http.setTimeout(0);
		port = await listenLoopback(http);
		if (closing) throw new Error("Tailcat disconnected during startup");
		return {
			endpoint,
			port,
			url: access.url,
			target,
			browserCookie: access.cookie,
			close,
			get closed() {
				return closing !== undefined;
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}
