import { afterEach, describe, expect, it } from "bun:test";
import {
	closestHostname,
	createProxyFetch,
	HOPS_HEADER,
	hostnameFromHostHeader,
	MAX_PROXY_HOPS,
	startLocalProxy,
} from "./proxy";

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
			listHostnames: () => [...routes.keys()],
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const response = await fetch(`http://127.0.0.1:${proxy.httpsPort}/hello`, {
			headers: { host: "api.serpier.localhost" },
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			proto: string;
			host: string;
			hops: string;
		};
		expect(body.proto).toBe("http");
		expect(body.host).toBe("api.serpier.localhost");
		expect(body.hops).toBe("1");
	});

	it("returns 508 when hop limit is exceeded", async () => {
		const fetchHandler = createProxyFetch({
			lookup: () => 9,
			listHostnames: () => ["api.serpier.localhost"],
			https: true,
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
			listHostnames: () => ["api.serpier.localhost"],
			https: true,
		});
		const request = new Request("https://tenant.api.serpier.localhost/", {
			headers: { host: "tenant.api.serpier.localhost" },
		});
		const response = await fetchHandler(request, {} as never);
		expect(response.status).toBe(404);
		expect(await response.text()).toContain("api.serpier.localhost");
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
			listHostnames: () => [...routes.keys()],
			httpsPort: 0,
			hostname: "127.0.0.1",
		});
		servers.push(proxy);

		const socket = new WebSocket(`ws://127.0.0.1:${proxy.httpsPort}/ws`, {
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
});
