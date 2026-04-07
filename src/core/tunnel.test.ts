import { describe, expect, it } from "bun:test";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import {
	type PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "./tunnel";

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
	it("starts tunnels and returns public URLs", async () => {
		const tunnels = await startPublicTunnels(
			[{ kind: "app", name: "api", port: 3000 }],
			{
				start: async ({ url }) => ({
					url: `https://public.example.com?target=${encodeURIComponent(url)}`,
					close: async () => {},
				}),
			},
		);

		expect(tunnels).toHaveLength(1);
		expect(tunnels[0]?.name).toBe("api");
		expect(tunnels[0]?.localUrl).toBe("http://localhost:3000");
		expect(tunnels[0]?.publicUrl).toContain("https://public.example.com");
	});

	it("resolves public URL from getURL when present", async () => {
		const tunnels = await startPublicTunnels(
			[{ kind: "app", name: "api", port: 3000 }],
			{
				start: async ({ url }) => ({
					getURL: async () =>
						`https://geturl.example.com?t=${encodeURIComponent(url)}`,
					close: async () => {},
				}),
			},
		);

		expect(tunnels).toHaveLength(1);
		expect(tunnels[0]?.publicUrl).toContain("https://geturl.example.com");
		expect(tunnels[0]?.publicUrl).toContain(
			encodeURIComponent("http://localhost:3000"),
		);
	});

	it("rejects empty getURL result", async () => {
		await expect(
			startPublicTunnels([{ kind: "app", name: "api", port: 3000 }], {
				start: async () => ({
					getURL: async () => "",
					close: async () => {},
				}),
			}),
		).rejects.toThrow("did not provide a public URL");
	});

	it("closes already-started tunnels when a later start fails", async () => {
		let closeCalls = 0;
		await expect(
			startPublicTunnels(
				[
					{ kind: "app", name: "api", port: 3000 },
					{ kind: "service", name: "postgres", port: 5432 },
				],
				{
					start: async ({ url }) => {
						if (url.includes("5432")) {
							throw new Error("failed to start");
						}
						return {
							url: "https://ok.example.com",
							close: async () => {
								closeCalls += 1;
							},
						};
					},
				},
			),
		).rejects.toThrow("failed to start");

		expect(closeCalls).toBe(1);
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
});
