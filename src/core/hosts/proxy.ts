import type { Server } from "bun";

export const HOPS_HEADER = "x-buncargo-hops";
export const MAX_PROXY_HOPS = 5;
export const HEALTH_PATH = "/_buncargo/health";

const LOOP_MESSAGE =
	"Loop Detected: request has passed through buncargo too many times.\nAdd changeOrigin: true to your dev server proxy config.\n";

export type ProxyRouteLookup = (hostname: string) => number | undefined;

/**
 * Connection-scoped headers that describe the hop we terminated, not the
 * request. Forwarding them upstream (RFC 9110 7.6.1) makes the dev server
 * negotiate against a connection that ends at the proxy.
 */
const HOP_BY_HOP_HEADERS = [
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
];

/**
 * The subprotocol the client offered, which the upstream handshake has to
 * repeat verbatim.
 *
 * Vite only adopts an upgrade whose `sec-websocket-protocol` is `vite-hmr`;
 * anything else leaves the socket in its HTTP server with no `error` listener,
 * and the next reset takes the dev server down with an unhandled ECONNRESET.
 */
export function requestedSubprotocol(request: Request): string | undefined {
	const offered = request.headers.get("sec-websocket-protocol");
	if (!offered) return undefined;
	return offered.split(",")[0]?.trim() || undefined;
}

export function hostnameFromHostHeader(host: string | null): string {
	if (!host) return "";
	const trimmed = host.trim().toLowerCase();
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		return end === -1 ? trimmed : trimmed.slice(1, end);
	}
	const colon = trimmed.lastIndexOf(":");
	if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
		return trimmed.slice(0, colon);
	}
	return trimmed;
}

export function closestHostname(
	hostname: string,
	known: string[],
): string | undefined {
	if (known.includes(hostname)) return hostname;
	let best: string | undefined;
	let bestScore = 0;
	for (const candidate of known) {
		if (
			hostname.endsWith(`.${candidate}`) ||
			candidate.endsWith(`.${hostname}`)
		) {
			const score = Math.min(hostname.length, candidate.length);
			if (score > bestScore) {
				best = candidate;
				bestScore = score;
			}
		}
	}
	return best;
}

export function createProxyFetch(input: {
	lookup: ProxyRouteLookup;
	listHostnames: () => string[];
	https: boolean;
}): (
	request: Request,
	server: Server<unknown>,
) => Response | Promise<Response> {
	const { lookup, listHostnames, https } = input;

	return async (request, server) => {
		const url = new URL(request.url);
		if (url.pathname === HEALTH_PATH) {
			return Response.json({ ok: true, routes: listHostnames().length });
		}

		const hostname = hostnameFromHostHeader(request.headers.get("host"));
		const hops =
			Number.parseInt(request.headers.get(HOPS_HEADER) ?? "0", 10) || 0;
		if (hops >= MAX_PROXY_HOPS) {
			return new Response(LOOP_MESSAGE, {
				status: 508,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		const port = lookup(hostname);
		if (port === undefined) {
			const hint = closestHostname(hostname, listHostnames());
			const message = hint
				? `No route for ${hostname}. Closest registered hostname: ${hint}\n`
				: `No route for ${hostname || "(missing Host)"}\n`;
			return new Response(message, {
				status: 404,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			const protocol = requestedSubprotocol(request);
			const ok = server.upgrade(request, {
				data: {
					targetPort: port,
					path: `${url.pathname}${url.search}`,
					protocol,
					pending: [],
				},
				...(protocol
					? { headers: { "sec-websocket-protocol": protocol } }
					: {}),
			});
			if (ok) {
				return undefined as unknown as Response;
			}
			// Falling through would forward the upgrade over `fetch`, which
			// cannot complete a handshake and leaves the upstream mid-switch.
			return new Response("Malformed WebSocket upgrade request\n", {
				status: 400,
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}

		const headers = new Headers(request.headers);
		for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
		headers.set(HOPS_HEADER, String(hops + 1));
		headers.set("x-forwarded-proto", https ? "https" : "http");
		headers.set("x-forwarded-host", hostname);
		const forwardedFor = request.headers.get("x-forwarded-for");
		headers.set(
			"x-forwarded-for",
			forwardedFor ? `${forwardedFor}, 127.0.0.1` : "127.0.0.1",
		);
		headers.delete("host");

		const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
		try {
			return await fetch(target, {
				method: request.method,
				headers,
				body:
					request.method === "GET" || request.method === "HEAD"
						? undefined
						: request.body,
				redirect: "manual",
				// @ts-expect-error Bun duplex
				duplex: "half",
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return new Response(
				`Upstream ${hostname} (${port}) is not reachable: ${message}\n`,
				{
					status: 502,
					headers: { "content-type": "text/plain; charset=utf-8" },
				},
			);
		}
	};
}

interface ProxyWsData {
	targetPort: number;
	path: string;
	protocol?: string;
	socket?: WebSocket;
	/** Frames the client sent before the upstream handshake completed. */
	pending: (string | Buffer)[];
}

interface ProxyWs {
	data: ProxyWsData;
	send: (data: string | Buffer) => void;
	close: (code?: number, reason?: string) => void;
}

export interface ProxyWebsocketHandlers {
	open: (ws: ProxyWs) => void;
	message: (ws: ProxyWs, message: string | Buffer) => void;
	close: (ws: ProxyWs) => void;
	/** Hand every bridged upstream a close frame before the proxy goes away. */
	closeAll: () => void;
}

const GOING_AWAY = 1001;
/**
 * Frames to hold while the upstream handshake completes.
 *
 * A handshake that never finishes would otherwise let a chatty client grow this
 * without bound inside a daemon that runs for days.
 */
const MAX_PENDING_FRAMES = 32;

export function createWebsocketHandlers(): ProxyWebsocketHandlers {
	const upstreams = new Set<WebSocket>();

	return {
		open(ws) {
			const socket = new WebSocket(
				`ws://127.0.0.1:${ws.data.targetPort}${ws.data.path}`,
				ws.data.protocol ? [ws.data.protocol] : undefined,
			);
			ws.data.socket = socket;
			upstreams.add(socket);
			socket.addEventListener("open", () => {
				// The client is upgraded before this handshake finishes, so
				// anything it sent in between is only queued, never dropped.
				for (const frame of ws.data.pending) socket.send(frame);
				ws.data.pending.length = 0;
			});
			socket.addEventListener("message", (event) => {
				ws.send(
					typeof event.data === "string"
						? event.data
						: Buffer.from(event.data as ArrayBuffer),
				);
			});
			socket.addEventListener("close", () => {
				upstreams.delete(socket);
				ws.close();
			});
			socket.addEventListener("error", () => {
				upstreams.delete(socket);
				ws.close();
			});
		},
		message(ws, message) {
			const socket = ws.data.socket;
			if (!socket || socket.readyState !== WebSocket.OPEN) {
				if (ws.data.pending.length >= MAX_PENDING_FRAMES) {
					// The upstream is not coming up; drop the client rather than
					// buffer for it indefinitely.
					ws.data.pending.length = 0;
					ws.close();
					return;
				}
				ws.data.pending.push(message);
				return;
			}
			socket.send(message);
		},
		close(ws) {
			ws.data.pending.length = 0;
			const socket = ws.data.socket;
			if (!socket) return;
			upstreams.delete(socket);
			socket.close();
		},
		closeAll() {
			for (const socket of upstreams) {
				try {
					socket.close(GOING_AWAY, "buncargo proxy restarting");
				} catch {
					// already closing
				}
			}
			upstreams.clear();
		},
	};
}

export interface LocalProxy {
	stop: () => void;
	httpsPort: number;
	httpPort?: number;
}

export async function startLocalProxy(options: {
	lookup: ProxyRouteLookup;
	listHostnames: () => string[];
	cert?: string;
	key?: string;
	httpsPort: number;
	httpPort?: number;
	hostname?: string;
}): Promise<LocalProxy> {
	const hostname = options.hostname ?? "127.0.0.1";
	const https = Boolean(options.cert && options.key);
	const fetchHandler = createProxyFetch({
		lookup: options.lookup,
		listHostnames: options.listHostnames,
		https,
	});
	const websocket = createWebsocketHandlers();

	const httpsServer = Bun.serve({
		hostname,
		port: options.httpsPort,
		fetch: fetchHandler,
		websocket: websocket as never,
		...(https
			? {
					tls: {
						cert: options.cert,
						key: options.key,
					},
				}
			: {}),
	});

	let httpServer: ReturnType<typeof Bun.serve> | undefined;
	if (options.httpPort !== undefined) {
		httpServer = Bun.serve({
			hostname,
			port: options.httpPort,
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === HEALTH_PATH) {
					return Response.json({ ok: true, redirect: true });
				}
				const host = hostnameFromHostHeader(request.headers.get("host"));
				return new Response(null, {
					status: 301,
					headers: {
						location: `https://${host}${url.pathname}${url.search}`,
					},
				});
			},
		});
	}

	const httpsPort = httpsServer.port;
	if (httpsPort === undefined) {
		httpsServer.stop(true);
		httpServer?.stop(true);
		throw new Error("Failed to bind the local hosts proxy");
	}

	return {
		httpsPort,
		httpPort: httpServer?.port,
		stop() {
			// Close the bridged upstreams first: a forced server stop resets
			// them, and a reset is what kills dev servers that do not guard
			// their upgraded sockets.
			websocket.closeAll();
			httpsServer.stop(true);
			httpServer?.stop(true);
		},
	};
}

const HEALTH_TIMEOUT_MS = 500;

/**
 * Whether a health body came from a buncargo proxy.
 *
 * A bare 200 is not enough. `ensureHostsDaemonRunning` skips the port-squatter
 * check once health passes, so treating any responder on :443 as ours would
 * hand the whole named-host flow to whatever else is listening.
 */
function isProxyHealthBody(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const body = value as { ok?: unknown; routes?: unknown; redirect?: unknown };
	if (body.ok !== true) return false;
	return typeof body.routes === "number" || body.redirect === true;
}

/**
 * Probe the scheme the proxy actually serves.
 *
 * Racing an HTTP and an HTTPS probe against the same port means one of them is
 * always speaking the wrong protocol into the listener.
 */
export async function isProxyHealthy(
	port = 443,
	hostname = "127.0.0.1",
	options: { tls?: boolean } = {},
): Promise<boolean> {
	const tls = options.tls ?? true;
	const url = `${tls ? "https" : "http"}://${hostname}:${port}${HEALTH_PATH}`;
	try {
		const response = await fetch(url, {
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			...(tls ? { tls: { rejectUnauthorized: false } } : {}),
		});
		if (!response.ok) return false;
		return isProxyHealthBody(await response.json());
	} catch {
		return false;
	}
}
