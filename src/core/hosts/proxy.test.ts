import { afterEach, describe, expect, it } from "bun:test";
import { HOSTS_PROTOCOL } from "./protocol";
import {
	closestHostname,
	createProxyFetch,
	createWebsocketHandlers,
	HEALTH_PATH,
	HOPS_HEADER,
	hostnameFromHostHeader,
	MAX_PROXY_HOPS,
	readProxyHealth,
	startLocalProxy,
} from "./proxy";
import { ACCEPT_TEST_TLS, TEST_TLS } from "./test-tls.testing";

/** Containers and CI images without IPv6 cannot exercise the ::1 fallback. */
const ipv6LoopbackAvailable = (() => {
	try {
		const server = Bun.serve({
			hostname: "::1",
			port: 0,
			fetch: () => new Response(),
		});
		server.stop(true);
		return true;
	} catch {
		return false;
	}
})();

/** A port nothing listens on, so both loopback families refuse. */
async function findClosedPort(): Promise<number> {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = server.port;
	server.stop(true);
	if (port === undefined) {
		throw new Error("Failed to bind a throwaway port");
	}
	return port;
}

describe("hostnameFromHostHeader", () => {
	it("strips a port", () => {
		expect(hostnameFromHostHeader("api.serpier.localhost:443")).toBe(
			"api.serpier.localhost",
		);
	});

	it("keeps a hostname without a port", () => {
		expect(hostnameFromHostHeader("api.serpier.localhost")).toBe(
			"api.serpier.localhost",
		);
	});
});

describe("closestHostname", () => {
	it("suggests a parent hostname", () => {
		expect(
			closestHostname("tenant.api.serpier.localhost", [
				"api.serpier.localhost",
				"web.serpier.localhost",
			]),
		).toBe("api.serpier.localhost");
	});
});

describe("proxy fetch", () => {
	const servers: Array<{ stop: () => void }> = [];

	afterEach(() => {
		for (const server of servers.splice(0)) {
			server.stop();
		}
	});

	it("routes by Host and sets forwarded headers", async () => {
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return Response.json({
					proto: request.headers.get("x-forwarded-proto"),
					host: request.headers.get("x-forwarded-host"),
					hops: request.headers.get(HOPS_HEADER),
				});
			},
		});
		servers.push(upstream);

		const routes = new Map([["api.serpier.localhost", upstream.port]]);
		const proxy = await startLocalProxy({
			lookup: (hostname) => routes.get(hostname),
			routes: () => ({
				hostnames: [...routes.keys()],
				lastReloadAt: Date.now(),
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const response = await fetch(`https://127.0.0.1:${proxy.httpsPort}/hello`, {
			...ACCEPT_TEST_TLS,
			headers: { host: "api.serpier.localhost" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			proto: string;
			host: string;
			hops: string;
		};
		expect(body.proto).toBe("https");
		expect(body.host).toBe("api.serpier.localhost");
		expect(body.hops).toBe("1");
	});

	// Browsers resolve `*.localhost` to ::1 as well and dial it first, so a
	// proxy that only holds 127.0.0.1 leaves them to whatever else is there.
	it.skipIf(!ipv6LoopbackAvailable)(
		"answers on both loopback families by default",
		async () => {
			const proxy = await startLocalProxy({
				lookup: () => undefined,
				routes: () => ({
					hostnames: ["api.serpier.localhost"],
					lastReloadAt: Date.now(),
				}),
				tls: TEST_TLS,
				httpsPort: 0,
			});
			servers.push(proxy);
			for (const hostname of ["127.0.0.1", "::1"]) {
				expect(await readProxyHealth(proxy.httpsPort, hostname)).toMatchObject({
					hostnames: ["api.serpier.localhost"],
				});
			}
		},
	);

	// A busy :80 threw after the https listeners were bound, and nothing
	// stopped them: health listed no hostnames, every run fell back, and each
	// retry left another reuse-port listener behind.
	it("serves https without the redirect when its port is taken, and leaves no listener behind", async () => {
		const redirectHolder = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("someone else"),
		});
		servers.push(redirectHolder);
		const httpsPort = await findClosedPort();

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const proxy = await startLocalProxy({
				lookup: () => undefined,
				routes: () => ({ hostnames: ["web.demo.localhost"], lastReloadAt: 1 }),
				tls: TEST_TLS,
				httpsPort,
				httpPort: redirectHolder.port,
				hostname: "127.0.0.1",
			});
			expect(proxy.redirectError).toContain(`:${redirectHolder.port}`);
			expect(await readProxyHealth(httpsPort, "127.0.0.1")).toMatchObject({
				hostnames: ["web.demo.localhost"],
			});
			proxy.stop();
		}

		// Binds without SO_REUSEPORT only once no listener holds the port.
		const exclusive = Bun.serve({
			hostname: "127.0.0.1",
			port: httpsPort,
			fetch: () => new Response(),
		});
		exclusive.stop(true);
	});

	// An empty pair once bound plain HTTP on :443 while the CLI probed HTTPS
	// and reported the daemon down.
	it("refuses to serve TLS from an empty certificate", async () => {
		await expect(
			startLocalProxy({
				lookup: () => undefined,
				routes: () => ({ hostnames: [], lastReloadAt: Date.now() }),
				tls: { cert: "", key: "" },
				httpsPort: 0,
				hostname: "127.0.0.1",
			}),
		).rejects.toThrow("is empty");
	});

	it("returns 508 when hop limit is exceeded", async () => {
		const fetchHandler = createProxyFetch({
			lookup: () => 9,
			routes: () => ({
				hostnames: ["api.serpier.localhost"],
				lastReloadAt: Date.now(),
			}),
		});
		const request = new Request("https://api.serpier.localhost/", {
			headers: {
				host: "api.serpier.localhost",
				[HOPS_HEADER]: String(MAX_PROXY_HOPS),
			},
		});
		const response = await fetchHandler(request, {} as never);
		expect(response.status).toBe(508);
		expect(await response.text()).toContain("changeOrigin: true");
	});

	it("returns 404 with the closest hostname", async () => {
		const fetchHandler = createProxyFetch({
			lookup: () => undefined,
			routes: () => ({
				hostnames: ["api.serpier.localhost"],
				lastReloadAt: Date.now(),
			}),
		});
		const request = new Request("https://tenant.api.serpier.localhost/", {
			headers: { host: "tenant.api.serpier.localhost" },
		});
		const response = await fetchHandler(request, {} as never);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("api.serpier.localhost");
	});

	it("reports its protocol, the served hostnames and the last refresh in the health body", async () => {
		const fetchHandler = createProxyFetch({
			lookup: () => undefined,
			routes: () => ({
				hostnames: ["api.serpier.localhost"],
				lastReloadAt: 1000,
			}),
		});
		const response = await fetchHandler(
			new Request(`https://127.0.0.1${HEALTH_PATH}`),
			{} as never,
		);
		expect(await response.json()).toEqual({
			ok: true,
			protocol: HOSTS_PROTOCOL,
			routes: 1,
			hostnames: ["api.serpier.localhost"],
			lastReloadAt: 1000,
		});
	});

	it("notices a frozen route map from the request path", async () => {
		const stalls: number[] = [];
		const fetchHandler = createProxyFetch({
			lookup: () => undefined,
			routes: () => ({ hostnames: [], lastReloadAt: 0 }),
			staleAfterMs: 45_000,
			onStale: (ageMs) => stalls.push(ageMs),
			now: () => 60_000,
		});

		const response = await fetchHandler(
			new Request("https://api.serpier.localhost/", {
				headers: { host: "api.serpier.localhost" },
			}),
			{} as never,
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("has not refreshed in 60s");
		expect(stalls).toEqual([60_000]);
	});

	it("stays quiet while the route map is fresh", async () => {
		const stalls: number[] = [];
		const fetchHandler = createProxyFetch({
			lookup: () => undefined,
			routes: () => ({ hostnames: [], lastReloadAt: 59_000 }),
			staleAfterMs: 45_000,
			onStale: (ageMs) => stalls.push(ageMs),
			now: () => 60_000,
		});

		const response = await fetchHandler(
			new Request("https://api.serpier.localhost/", {
				headers: { host: "api.serpier.localhost" },
			}),
			{} as never,
		);
		expect(await response.text()).not.toContain("has not refreshed");
		expect(stalls).toEqual([]);
	});

	it("bridges WebSocket upgrades", async () => {
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) {
					return undefined as unknown as Response;
				}
				return new Response("expected websocket", { status: 400 });
			},
			websocket: {
				open(ws) {
					ws.send("hello");
				},
				message(ws, message) {
					ws.send(message);
				},
			},
		});
		servers.push(upstream);

		const routes = new Map([["api.serpier.localhost", upstream.port]]);
		const proxy = await startLocalProxy({
			lookup: (hostname) => routes.get(hostname),
			routes: () => ({
				hostnames: [...routes.keys()],
				lastReloadAt: Date.now(),
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const socket = new WebSocket(`wss://127.0.0.1:${proxy.httpsPort}/ws`, {
			...ACCEPT_TEST_TLS,
			headers: { host: "api.serpier.localhost" },
		} as never);
		const first = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for websocket")),
				2000,
			);
			socket.addEventListener("message", (event) => {
				clearTimeout(timer);
				resolve(String(event.data));
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("websocket error"));
			});
		});
		expect(first).toBe("hello");
		socket.close();
	});

	it("repeats the client subprotocol to the upstream and back", async () => {
		const upstreamProtocols: Array<string | null> = [];
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				const protocol = request.headers.get("sec-websocket-protocol");
				upstreamProtocols.push(protocol);
				if (
					server.upgrade(request, {
						headers: protocol
							? { "sec-websocket-protocol": protocol }
							: undefined,
					})
				) {
					return undefined as unknown as Response;
				}
				return new Response("expected websocket", { status: 400 });
			},
			websocket: {
				open(ws) {
					ws.send("hello");
				},
				message() {},
			},
		});
		servers.push(upstream);

		const routes = new Map([["api.serpier.localhost", upstream.port]]);
		const proxy = await startLocalProxy({
			lookup: (hostname) => routes.get(hostname),
			routes: () => ({
				hostnames: [...routes.keys()],
				lastReloadAt: Date.now(),
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const socket = new WebSocket(`wss://127.0.0.1:${proxy.httpsPort}/`, {
			...ACCEPT_TEST_TLS,
			headers: { host: "api.serpier.localhost" },
			protocols: ["vite-hmr"],
		} as never);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for websocket")),
				2000,
			);
			socket.addEventListener("message", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("websocket error"));
			});
		});
		expect(upstreamProtocols).toEqual(["vite-hmr"]);
		expect(socket.protocol).toBe("vite-hmr");
		socket.close();
	});

	it("rejects an upgrade it cannot bridge instead of forwarding it", async () => {
		const fetchHandler = createProxyFetch({
			lookup: () => 9,
			routes: () => ({
				hostnames: ["api.serpier.localhost"],
				lastReloadAt: Date.now(),
			}),
		});
		const request = new Request("https://api.serpier.localhost/", {
			headers: { host: "api.serpier.localhost", upgrade: "websocket" },
		});
		const response = await fetchHandler(request, {
			upgrade: () => false,
		} as never);
		expect(response.status).toBe(400);
	});

	it("forwards a gzip body without relabeling it as compressed plaintext", async () => {
		const html = "<!DOCTYPE html><title>Mailpit</title>";
		const gzipped = Bun.gzipSync(new TextEncoder().encode(html));
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				return new Response(gzipped, {
					headers: {
						"content-encoding": "gzip",
						"content-type": "text/html; charset=utf-8",
					},
				});
			},
		});
		servers.push(upstream);

		const routes = new Map([["mailpit.serpier.localhost", upstream.port]]);
		const proxy = await startLocalProxy({
			lookup: (hostname) => routes.get(hostname),
			routes: () => ({
				hostnames: [...routes.keys()],
				lastReloadAt: Date.now(),
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const url = `https://127.0.0.1:${proxy.httpsPort}/`;
		const decoded = await fetch(url, {
			...ACCEPT_TEST_TLS,
			headers: { host: "mailpit.serpier.localhost" },
		});
		expect(decoded.status).toBe(200);
		expect(await decoded.text()).toBe(html);

		const wire = await fetch(url, {
			...ACCEPT_TEST_TLS,
			headers: {
				host: "mailpit.serpier.localhost",
				"accept-encoding": "gzip",
			},
			decompress: false,
		});
		expect(wire.headers.get("content-encoding")).toBe("gzip");
		const bytes = new Uint8Array(await wire.arrayBuffer());
		expect(bytes[0]).toBe(0x1f);
		expect(bytes[1]).toBe(0x8b);
	});

	it("drops hop-by-hop headers before forwarding", async () => {
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return Response.json({
					connection: request.headers.get("connection"),
					keepAlive: request.headers.get("keep-alive"),
				});
			},
		});
		servers.push(upstream);

		const routes = new Map([["api.serpier.localhost", upstream.port]]);
		const proxy = await startLocalProxy({
			lookup: (hostname) => routes.get(hostname),
			routes: () => ({
				hostnames: [...routes.keys()],
				lastReloadAt: Date.now(),
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const response = await fetch(`https://127.0.0.1:${proxy.httpsPort}/`, {
			...ACCEPT_TEST_TLS,
			headers: { host: "api.serpier.localhost", "keep-alive": "timeout=5" },
		});
		const body = (await response.json()) as {
			connection: string | null;
			keepAlive: string | null;
		};
		expect(body.keepAlive).toBeNull();
	});

	// Vite's default `localhost` bind listens on IPv6 loopback only, so a proxy
	// that dials 127.0.0.1 unconditionally 502s every named URL for a Vite app.
	it.skipIf(!ipv6LoopbackAvailable)(
		"reaches an upstream bound to IPv6 loopback only",
		async () => {
			const upstream = Bun.serve({
				hostname: "::1",
				port: 0,
				fetch() {
					return new Response("from ipv6");
				},
			});
			servers.push(upstream);

			const routes = new Map([["web.serpier.localhost", upstream.port]]);
			const proxy = await startLocalProxy({
				lookup: (hostname) => routes.get(hostname),
				routes: () => ({
					hostnames: [...routes.keys()],
					lastReloadAt: Date.now(),
				}),
				tls: TEST_TLS,
				httpsPort: 0,
				hostname: "127.0.0.1",
			});
			servers.push(proxy);

			const response = await fetch(`https://127.0.0.1:${proxy.httpsPort}/`, {
				...ACCEPT_TEST_TLS,
				headers: { host: "web.serpier.localhost" },
			});
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("from ipv6");
		},
	);

	it.skipIf(!ipv6LoopbackAvailable)(
		"bridges a WebSocket to an upstream bound to IPv6 loopback only",
		async () => {
			const upstream = Bun.serve({
				hostname: "::1",
				port: 0,
				fetch(request, server) {
					if (server.upgrade(request)) {
						return undefined as unknown as Response;
					}
					return new Response("expected websocket", { status: 400 });
				},
				websocket: {
					open(ws) {
						ws.send("hello from ipv6");
					},
					message() {},
				},
			});
			servers.push(upstream);

			const routes = new Map([["web.serpier.localhost", upstream.port]]);
			const proxy = await startLocalProxy({
				lookup: (hostname) => routes.get(hostname),
				routes: () => ({
					hostnames: [...routes.keys()],
					lastReloadAt: Date.now(),
				}),
				tls: TEST_TLS,
				httpsPort: 0,
				hostname: "127.0.0.1",
			});
			servers.push(proxy);

			const socket = new WebSocket(`wss://127.0.0.1:${proxy.httpsPort}/ws`, {
				...ACCEPT_TEST_TLS,
				headers: { host: "web.serpier.localhost" },
			} as never);
			const first = await new Promise<string>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("timed out waiting for websocket")),
					2000,
				);
				socket.addEventListener("message", (event) => {
					clearTimeout(timer);
					resolve(String(event.data));
				});
				socket.addEventListener("error", () => {
					clearTimeout(timer);
					reject(new Error("websocket error"));
				});
			});
			expect(first).toBe("hello from ipv6");
			socket.close();
		},
	);

	it("names both loopback families when neither answers", async () => {
		const deadPort = await findClosedPort();
		const fetchHandler = createProxyFetch({
			lookup: () => deadPort,
			routes: () => ({
				hostnames: ["web.serpier.localhost"],
				lastReloadAt: Date.now(),
			}),
		});
		const request = new Request("https://web.serpier.localhost/", {
			headers: { host: "web.serpier.localhost" },
		});
		const response = await fetchHandler(request, {} as never);
		expect(response.status).toBe(502);
		const body = await response.text();
		expect(body).toContain("127.0.0.1");
		expect(body).toContain("[::1]");
	});

	// A rebind force-stops the listener, which resets whatever it still holds.
	// A dev server whose upgraded socket is reset dies with an unhandled
	// ECONNRESET, so the bridged upstream is owed a close frame first.
	it("sends the upstream a close frame before stopping", async () => {
		const closed = Promise.withResolvers<number>();
		const upstream = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, server) {
				if (server.upgrade(request)) {
					return undefined as unknown as Response;
				}
				return new Response("expected websocket", { status: 400 });
			},
			websocket: {
				open(ws) {
					ws.send("hello");
				},
				message() {},
				close(_ws, code) {
					closed.resolve(code);
				},
			},
		});
		servers.push(upstream);

		const routes = new Map([["api.serpier.localhost", upstream.port]]);
		const proxy = await startLocalProxy({
			lookup: (hostname) => routes.get(hostname),
			routes: () => ({
				hostnames: [...routes.keys()],
				lastReloadAt: Date.now(),
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});

		const client = new WebSocket(`wss://127.0.0.1:${proxy.httpsPort}/`, {
			...ACCEPT_TEST_TLS,
			headers: { host: "api.serpier.localhost" },
		} as never);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out")), 2000);
			client.addEventListener("message", () => {
				clearTimeout(timer);
				resolve();
			});
			client.addEventListener("error", () => {
				clearTimeout(timer);
				reject(new Error("websocket error"));
			});
		});

		proxy.stop();
		// 1001 (going away) is the close frame; a bare reset reports otherwise.
		expect(await closed.promise).toBe(1001);
		client.close();
	});
});

describe("createWebsocketHandlers", () => {
	// The HTTP path forgot a failed family; the WebSocket path did not, so HMR
	// kept dialing 127.0.0.1 after Vite came back on ::1.
	it("forgets the remembered family when the upstream dial fails", async () => {
		const port = await findClosedPort();
		const { promise: forgotten, resolve: forget } =
			Promise.withResolvers<number>();
		const handlers = createWebsocketHandlers({
			resolve: async () => ({ host: "127.0.0.1", authority: "127.0.0.1" }),
			forget,
		});
		const { promise: closed, resolve: close } = Promise.withResolvers<void>();

		handlers.open({
			data: { targetPort: port, path: "/", pending: [] },
			send: () => {},
			close: () => close(),
		});

		expect(await forgotten).toBe(port);
		await closed;
	});
});

describe("readProxyHealth", () => {
	const servers: Array<{ stop: () => void }> = [];

	afterEach(() => {
		for (const server of servers.splice(0)) {
			server.stop();
		}
	});

	it("answers undefined quickly when nothing is listening", async () => {
		const started = Date.now();
		expect(await readProxyHealth(59_998, "127.0.0.1")).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("detects a bound proxy over HTTPS", async () => {
		const proxy = await startLocalProxy({
			lookup: () => undefined,
			routes: () => ({ hostnames: [], lastReloadAt: Date.now() }),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);
		expect(await readProxyHealth(proxy.httpsPort, "127.0.0.1")).toBeDefined();
	});

	it("reads back what the proxy is serving", async () => {
		const proxy = await startLocalProxy({
			lookup: () => undefined,
			routes: () => ({
				hostnames: ["api.serpier.localhost"],
				lastReloadAt: 1234,
			}),
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);
		expect(await readProxyHealth(proxy.httpsPort, "127.0.0.1")).toEqual({
			protocol: HOSTS_PROTOCOL,
			routeCount: 1,
			hostnames: ["api.serpier.localhost"],
			lastReloadAt: 1234,
		});
	});

	// What the CLI's route check asks: one round trip instead of polling for
	// the daemon's next reload.
	it("reloads before answering a refresh probe, and only then", async () => {
		let hostnames: string[] = [];
		let refreshes = 0;
		const proxy = await startLocalProxy({
			lookup: () => undefined,
			routes: () => ({ hostnames, lastReloadAt: Date.now() }),
			refresh: async () => {
				refreshes += 1;
				hostnames = ["web.demo.localhost"];
			},
			tls: TEST_TLS,
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		expect(await readProxyHealth(proxy.httpsPort)).toMatchObject({
			hostnames: [],
		});
		expect(refreshes).toBe(0);
		expect(
			await readProxyHealth(proxy.httpsPort, "127.0.0.1", { refresh: true }),
		).toMatchObject({ hostnames: ["web.demo.localhost"] });
		expect(refreshes).toBe(1);
	});

	// The daemon every machine runs until `hosts install` replaces it.
	it("reads a daemon from before the protocol as outdated", async () => {
		const outdated = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: TEST_TLS,
			fetch() {
				return Response.json({
					ok: true,
					routes: 1,
					hostnames: ["web.demo.localhost"],
					lastReloadAt: Date.now(),
				});
			},
		});
		servers.push(outdated);
		expect(await readProxyHealth(outdated.port ?? 0, "127.0.0.1")).toEqual({
			outdated: true,
		});
	});

	// Installed by a project on a later buncargo: it serves this one too.
	it("reads a daemon of a newer protocol as current", async () => {
		const newer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: TEST_TLS,
			fetch() {
				return Response.json({
					ok: true,
					protocol: HOSTS_PROTOCOL + 1,
					routes: 1,
					hostnames: ["web.demo.localhost"],
					lastReloadAt: 1234,
				});
			},
		});
		servers.push(newer);
		expect(await readProxyHealth(newer.port ?? 0, "127.0.0.1")).toEqual({
			protocol: HOSTS_PROTOCOL + 1,
			routeCount: 1,
			hostnames: ["web.demo.localhost"],
			lastReloadAt: 1234,
		});
	});

	it("rejects a foreign server answering 200 on the health path", async () => {
		const squatter = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: TEST_TLS,
			fetch() {
				return new Response("OK");
			},
		});
		servers.push(squatter);
		expect(
			await readProxyHealth(squatter.port ?? 0, "127.0.0.1"),
		).toBeUndefined();
	});

	it("rejects a JSON responder that is not a buncargo proxy", async () => {
		const squatter = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			tls: TEST_TLS,
			fetch() {
				return Response.json({ ok: true });
			},
		});
		servers.push(squatter);
		expect(
			await readProxyHealth(squatter.port ?? 0, "127.0.0.1"),
		).toBeUndefined();
	});
});
