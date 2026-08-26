import type { Server } from "bun";

export const HOPS_HEADER = "x-buncargo-hops";
export const MAX_PROXY_HOPS = 5;
export const HEALTH_PATH = "/_buncargo/health";

const LOOP_MESSAGE =
	"Loop Detected: request has passed through buncargo too many times.\nAdd changeOrigin: true to your dev server proxy config.\n";

export type ProxyRouteLookup = (hostname: string) => number | undefined;

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
			const ok = server.upgrade(request, {
				data: { targetPort: port, path: `${url.pathname}${url.search}` },
			});
			if (ok) {
				return undefined as unknown as Response;
			}
		}

		const headers = new Headers(request.headers);
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
	socket?: WebSocket;
}

export function createWebsocketHandlers(): {
	open: (ws: {
		data: ProxyWsData;
		send: (data: string | Buffer) => void;
		close: () => void;
	}) => void;
	message: (ws: { data: ProxyWsData }, message: string | Buffer) => void;
	close: (ws: { data: ProxyWsData }) => void;
} {
	return {
		open(ws) {
			const socket = new WebSocket(
				`ws://127.0.0.1:${ws.data.targetPort}${ws.data.path}`,
			);
			ws.data.socket = socket;
			socket.addEventListener("message", (event) => {
				ws.send(
					typeof event.data === "string"
						? event.data
						: Buffer.from(event.data as ArrayBuffer),
				);
			});
			socket.addEventListener("close", () => ws.close());
			socket.addEventListener("error", () => ws.close());
		},
		message(ws, message) {
			ws.data.socket?.send(message);
		},
		close(ws) {
			ws.data.socket?.close();
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
			httpsServer.stop(true);
			httpServer?.stop(true);
		},
	};
}

export async function isProxyHealthy(
	port = 443,
	hostname = "127.0.0.1",
): Promise<boolean> {
	try {
		const response = await fetch(`http://${hostname}:${port}${HEALTH_PATH}`, {
			signal: AbortSignal.timeout(500),
		});
		if (response.ok) return true;
	} catch {
		// try https
	}
	try {
		const response = await fetch(`https://${hostname}:${port}${HEALTH_PATH}`, {
			tls: { rejectUnauthorized: false },
			signal: AbortSignal.timeout(500),
		});
		return response.ok;
	} catch {
		return false;
	}
}
