import { afterEach, describe, expect, it } from "bun:test";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import {
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
	withoutPublicUrls,
} from "./tunnel";
import { type FakeCloudflared, fakeCloudflared } from "./tunnel.testing";

function createEnv(): DevEnvironment<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
> {
	return {
		services: {
			postgres: { port: 5432, expose: true },
			redis: { port: 6379 },
		},
		apps: {
			api: { port: 3000, devCommand: "bun run dev", expose: true },
			web: { port: 5173, devCommand: "bun run dev" },
		},
		ports: {
			postgres: 5432,
			redis: 6379,
			api: 3000,
			web: 5173,
		},
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
}

describe("resolveExposeTargets", () => {
	it("returns all expose:true targets when no names are provided", () => {
		const env = createEnv();
		const result = resolveExposeTargets(env);

		expect(result.unknownNames).toEqual([]);
		expect(result.notEnabledNames).toEqual([]);
		expect(result.targets.map((target) => target.name).sort()).toEqual([
			"api",
			"postgres",
		]);
	});

	it("validates unknown and not-enabled targets for explicit names", () => {
		const env = createEnv();
		const result = resolveExposeTargets(env, "api,redis,missing");

		expect(result.targets.map((target) => target.name)).toEqual(["api"]);
		expect(result.notEnabledNames).toEqual(["redis"]);
		expect(result.unknownNames).toEqual(["missing"]);
	});
});

describe("public tunnel lifecycle", () => {
	let cloudflared: FakeCloudflared | undefined;
	afterEach(() => cloudflared?.restore());

	it("opens a tunnel per target and returns its public URL", async () => {
		cloudflared = fakeCloudflared();
		const tunnels = await startPublicTunnels([
			{ kind: "app", name: "api", port: 3000 },
			{ kind: "service", name: "postgres", port: 5432 },
		]);
		try {
			expect(
				tunnels.map(({ name, localUrl, publicUrl }) => ({
					name,
					localUrl,
					publicUrl,
				})),
			).toEqual([
				{
					name: "api",
					localUrl: "http://localhost:3000",
					publicUrl: "https://p3000.trycloudflare.com",
				},
				{
					name: "postgres",
					localUrl: "http://localhost:5432",
					publicUrl: "https://p5432.trycloudflare.com",
				},
			]);
		} finally {
			await stopPublicTunnels(tunnels);
		}
		expect(cloudflared.running(3000)).toBe(false);
		expect(cloudflared.running(5432)).toBe(false);
	});

	it("closes the tunnels already open when a later one fails", async () => {
		cloudflared = fakeCloudflared({ failPorts: [5432] });
		await expect(
			startPublicTunnels([
				{ kind: "app", name: "api", port: 3000 },
				{ kind: "service", name: "postgres", port: 5432 },
			]),
		).rejects.toThrow("cloudflared exited before a tunnel URL was parsed");
		expect(cloudflared.started(3000)).toBe(true);
		expect(cloudflared.running(3000)).toBe(false);
	});

	it("stops all tunnels", async () => {
		let closeCalls = 0;
		const tunnels: PublicTunnel[] = [
			{
				kind: "app",
				name: "api",
				localUrl: "http://localhost:3000",
				publicUrl: "https://api.example.com",
				close: async () => {
					closeCalls += 1;
				},
			},
			{
				kind: "service",
				name: "postgres",
				localUrl: "http://localhost:5432",
				publicUrl: "https://db.example.com",
				close: async () => {
					closeCalls += 1;
				},
			},
		];

		await stopPublicTunnels(tunnels);
		expect(closeCalls).toBe(2);
	});

	it("cancels a tunnel still waiting for its URL and stops cloudflared", async () => {
		const live = fakeCloudflared({ hangPorts: [3000] });
		cloudflared = live;
		const controller = new AbortController();
		const pending = startPublicTunnels(
			[{ kind: "app", name: "web", port: 3000 }],
			{ signal: controller.signal },
		);
		const deadline = Date.now() + 5000;
		while (!live.started(3000) && Date.now() < deadline) await Bun.sleep(10);
		controller.abort(new Error("cancelled"));
		await expect(pending).rejects.toThrow("cancelled");
		const stopped = Date.now() + 5000;
		while (live.running(3000) && Date.now() < stopped) await Bun.sleep(10);
		expect(live.running(3000)).toBe(false);
	});
});

it("closing tunnels clears only their URLs, not the ones apps printed", () => {
	const current = {
		api: "https://api.trycloudflare.com",
		web: "https://web.example",
		admin: "https://admin-now.example",
	};
	// The tunnels opened api and admin; admin has since printed its own URL.
	const opened = {
		api: "https://api.trycloudflare.com",
		admin: "https://admin.trycloudflare.com",
	};
	expect(withoutPublicUrls(current, opened)).toEqual({
		web: "https://web.example",
		admin: "https://admin-now.example",
	});
});
