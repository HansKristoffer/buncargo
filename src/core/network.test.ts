import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../types";
import { waitForDevServers, waitForServer } from "./network";

describe("waitForDevServers", () => {
	it("skips apps with healthEndpoint: false", async () => {
		const apps: Record<string, AppConfig> = {
			metro: {
				port: 1,
				devCommand: "bunx expo start",
				healthEndpoint: false,
			},
		};
		await expect(
			waitForDevServers(apps, { metro: 1 }, { verbose: false }),
		).resolves.toBeUndefined();
	});
});

describe("readiness elapsed time and HTTP semantics", () => {
	it("rejects a missing explicit health endpoint but permits a missing root page", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("missing", { status: 404 }),
		});
		try {
			await expect(
				waitForServer(server.url.href, { timeout: 100 }),
			).resolves.toBeUndefined();
			await expect(
				waitForDevServers(
					{
						web: {
							port: Number(server.port),
							devCommand: "bun dev",
							healthEndpoint: "/health",
							healthTimeout: 80,
						},
					},
					{ web: Number(server.port) },
					{ verbose: false },
				),
			).rejects.toThrow("did not respond");
		} finally {
			server.stop(true);
		}
	});

	it("clamps a stalled HTTP request to the total budget", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Promise<Response>(() => {}),
		});
		const start = performance.now();
		try {
			await expect(
				waitForServer(server.url.href, { timeout: 80 }),
			).rejects.toThrow("80ms");
			expect(performance.now() - start).toBeLessThan(500);
		} finally {
			server.stop(true);
		}
	});

	it("detects readiness with the faster default polling interval", async () => {
		const start = performance.now();
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response("", {
					status: performance.now() - start > 80 ? 200 : 503,
				}),
		});
		try {
			await waitForServer(server.url.href, { timeout: 1000 });
			expect(performance.now() - start).toBeLessThan(700);
		} finally {
			server.stop(true);
		}
	});

	it("cancels sibling probes when one app fails readiness", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("", { status: 503 }),
		});
		const start = performance.now();
		try {
			await expect(
				waitForDevServers(
					{
						a: {
							port: Number(server.port),
							devCommand: "bun dev",
							healthTimeout: 50,
						},
						b: {
							port: Number(server.port),
							devCommand: "bun dev",
							healthTimeout: 10000,
						},
					},
					{ a: Number(server.port), b: Number(server.port) },
					{ verbose: false },
				),
			).rejects.toThrow("50ms");
			expect(performance.now() - start).toBeLessThan(500);
		} finally {
			server.stop(true);
		}
	});
});
