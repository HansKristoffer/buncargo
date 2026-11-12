import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRunEntry,
	loadRuns,
	publishRun,
	retireRuns,
} from "../core/run-registry";
import {
	type PublicTunnel,
	resolveExposeTargets,
	stopPublicTunnels,
} from "../core/tunnel";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { createTunnelCoordinator } from "./dev-tunnels";

it("closes a tunnel acquired while startup is being cancelled", async () => {
	let closed = 0;
	const env = {
		services: { db: { port: 5432, expose: true } },
		apps: {},
		ports: { db: 5432 },
		root: process.cwd(),
		publicUrls: {},
		setPublicUrls: () => {},
		clearPublicUrls: () => {},
		logInfo: () => {},
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	const coordinator = createTunnelCoordinator(
		env,
		{
			resolveExposeTargets,
			stopPublicTunnels,
			startPublicTunnels: async (_targets, options) =>
				new Promise<PublicTunnel[]>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() =>
							setTimeout(
								() =>
									resolve([
										{
											kind: "service",
											name: "db",
											localUrl: "http://localhost:5432",
											publicUrl: "https://example.com",
											close: async () => {
												closed++;
											},
										},
									]),
								10,
							),
						{ once: true },
					);
				}),
		},
		{ exposeRequested: true },
	);
	await coordinator.planExpose({
		exposeValue: undefined,
		appsRequested: false,
		selectedAppNames: new Set(),
		selectedServiceNames: new Set(["db"]),
		startAppNames: new Set(),
		reusedAppNames: new Set(),
	});
	const opening = coordinator.openOwnedTunnels().catch(() => {});
	await coordinator.stop();
	await opening;
	expect(closed).toBe(1);
});

it("opens the tunnels again after an attempt that failed", async () => {
	const env = {
		services: { db: { port: 5432, expose: true } },
		apps: {},
		ports: { db: 5432 },
		root: process.cwd(),
		publicUrls: {},
		setPublicUrls: () => {},
		clearPublicUrls: () => {},
		logInfo: () => {},
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	let attempts = 0;
	const coordinator = createTunnelCoordinator(
		env,
		{
			resolveExposeTargets,
			stopPublicTunnels,
			startPublicTunnels: async () => {
				attempts++;
				if (attempts === 1) throw new Error("cloudflared is not reachable");
				return [
					{
						kind: "service",
						name: "db",
						localUrl: "http://localhost:5432",
						publicUrl: "https://example.com",
						close: async () => {},
					},
				];
			},
		},
		{ exposeRequested: true },
	);
	await coordinator.planExpose({
		exposeValue: undefined,
		appsRequested: false,
		selectedAppNames: new Set(),
		selectedServiceNames: new Set(["db"]),
		startAppNames: new Set(),
		reusedAppNames: new Set(),
	});

	await expect(coordinator.openOwnedTunnels()).rejects.toThrow(
		"cloudflared is not reachable",
	);
	expect(coordinator.hasPendingTargets()).toBe(true);
	await coordinator.openOwnedTunnels();
	expect(attempts).toBe(2);
	expect(coordinator.hasPendingTargets()).toBe(false);
	await coordinator.stop();
});

it("refuses an expose target outside --apps", async () => {
	const env = {
		services: { db: { port: 5432, expose: true } },
		apps: { web: { expose: true }, api: { expose: true } },
		ports: { db: 5432, web: 3000, api: 4000 },
		root: process.cwd(),
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	const coordinator = createTunnelCoordinator(
		env,
		{
			resolveExposeTargets,
			stopPublicTunnels,
			startPublicTunnels: async () => [],
		},
		{ exposeRequested: true },
	);

	await expect(
		coordinator.planExpose({
			exposeValue: "db, web,api",
			appsRequested: true,
			selectedAppNames: new Set(["web"]),
			startAppNames: new Set(["web"]),
			reusedAppNames: new Set(),
		}),
	).rejects.toThrow("Expose target not included in --apps: api");
});

it("keeps the URLs apps printed when its tunnels open and close", async () => {
	// Opening replaced the whole map and closing cleared it, so `dev --expose`
	// lost the URL an app printed (`captures`) before the tunnels opened.
	const publicUrls: Record<string, string> = {};
	const env = {
		services: { db: { port: 5432, expose: true } },
		apps: {},
		ports: { db: 5432 },
		root: process.cwd(),
		publicUrls,
		// Replaces the map in place, as the environment's does.
		setPublicUrls: (next: Record<string, string>) => {
			for (const key of Object.keys(publicUrls)) delete publicUrls[key];
			Object.assign(publicUrls, next);
		},
		clearPublicUrls: () => {},
		logInfo: () => {},
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	const coordinator = createTunnelCoordinator(
		env,
		{
			resolveExposeTargets,
			stopPublicTunnels,
			startPublicTunnels: async () => [
				{
					kind: "service",
					name: "db",
					localUrl: "http://localhost:5432",
					publicUrl: "https://db.trycloudflare.com",
					close: async () => {},
				},
			],
		},
		{ exposeRequested: true },
	);
	await coordinator.planExpose({
		exposeValue: undefined,
		appsRequested: false,
		selectedAppNames: new Set(),
		selectedServiceNames: new Set(["db"]),
		startAppNames: new Set(),
		reusedAppNames: new Set(),
	});
	// A wave-1 app printed its own public URL.
	env.setPublicUrls({ ...publicUrls, mobile: "https://mobile.exp.direct" });

	await coordinator.openOwnedTunnels();
	expect(publicUrls).toEqual({
		db: "https://db.trycloudflare.com",
		mobile: "https://mobile.exp.direct",
	});

	await coordinator.stop();
	expect(publicUrls).toEqual({ mobile: "https://mobile.exp.direct" });
});

it("inherits a reused app's tunnel URL from the live run serving it, on its port only", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-tunnel-reuse-"));
	const publicUrls: Record<string, string> = {};
	const env = {
		sessionId: "tunnel-reuser",
		services: {},
		apps: {
			api: { port: 4100, expose: true },
			web: { port: 4101, expose: true },
			shop: { port: 4102, expose: true },
		},
		ports: { api: 4100, web: 4101, shop: 4102 },
		root,
		publicUrls,
		setPublicUrls: (next: Record<string, string>) => {
			for (const key of Object.keys(publicUrls)) delete publicUrls[key];
			Object.assign(publicUrls, next);
		},
		clearPublicUrls: () => {},
		logInfo: () => {},
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	const row = (name: string, port: number, urls: object = {}) => ({
		name,
		port,
		url: `http://localhost:${port}`,
		loopbackUrl: `http://localhost:${port}`,
		status: "ready" as const,
		...urls,
	});
	const tunnel = (name: string) => {
		const url = `https://${name}.trycloudflare.com`;
		return { publicUrl: url, tunnelUrl: url };
	};
	const entry = (sessionId: string, apps: ReturnType<typeof row>[]) => ({
		...buildRunEntry({
			sessionId,
			projectPrefix: "demo",
			projectName: "demo",
			root,
			isWorktree: false,
		}),
		apps,
	});
	// This process stands in for the run that serves the apps. Its `web`
	// tunnel is on a port this run would not use, and `shop`'s public URL is
	// one the app printed, not a tunnel.
	await publishRun(
		entry("tunnel-owner", [
			row("api", 4100, tunnel("api")),
			row("web", 4999, tunnel("web")),
			row("shop", 4102, { publicUrl: "https://shop.example.dev" }),
		]),
	);
	await publishRun(
		entry("tunnel-reuser", [
			row("api", 4100),
			row("web", 4101),
			row("shop", 4102),
		]),
	);
	const opened: string[] = [];
	const coordinator = createTunnelCoordinator(
		env,
		{
			resolveExposeTargets,
			stopPublicTunnels,
			startPublicTunnels: async (targets) => {
				opened.push(...targets.map((target) => target.name));
				return targets.map((target) => ({
					...target,
					localUrl: `http://localhost:${target.port}`,
					publicUrl: `https://${target.name}-new.trycloudflare.com`,
					close: async () => {},
				}));
			},
		},
		{ exposeRequested: true },
	);

	try {
		await coordinator.planExpose({
			exposeValue: undefined,
			appsRequested: false,
			selectedAppNames: new Set(["api", "web", "shop"]),
			startAppNames: new Set(),
			reusedAppNames: new Set(["api", "web", "shop"]),
		});
		await coordinator.openOwnedTunnels();

		expect(coordinator.inheritsPublicUrls()).toBe(true);
		expect(opened).toEqual(["web", "shop"]);
		expect(publicUrls).toEqual({
			api: "https://api.trycloudflare.com",
			web: "https://web-new.trycloudflare.com",
			shop: "https://shop-new.trycloudflare.com",
		});
		// This run's entry says which of its URLs are tunnels, for the next.
		const reuser = (await loadRuns()).find(
			(run) => run.sessionId === "tunnel-reuser",
		);
		expect(
			Object.fromEntries(
				(reuser?.apps ?? []).map((app) => [app.name, app.tunnelUrl]),
			),
		).toEqual({
			api: "https://api.trycloudflare.com",
			web: "https://web-new.trycloudflare.com",
			shop: "https://shop-new.trycloudflare.com",
		});
	} finally {
		await retireRuns(
			(await loadRuns()).filter((run) =>
				["tunnel-owner", "tunnel-reuser"].includes(run.sessionId),
			),
		);
		rmSync(root, { recursive: true, force: true });
	}
});
