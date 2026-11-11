import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunEntry, publishRun, retireRuns } from "../core/run-registry";
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

it("inherits a reused app's public URL from the live run serving it, on its port only", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-tunnel-reuse-"));
	const publicUrls: Record<string, string> = {};
	const env = {
		services: {},
		apps: {
			api: { port: 4100, expose: true },
			web: { port: 4101, expose: true },
		},
		ports: { api: 4100, web: 4101 },
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
	const served = (name: string, port: number) => ({
		name,
		port,
		url: `http://localhost:${port}`,
		loopbackUrl: `http://localhost:${port}`,
		publicUrl: `https://${name}.trycloudflare.com`,
		status: "ready" as const,
	});
	// This process stands in for the run that opened the tunnels. Its `web`
	// row is on a port this run would not use.
	await publishRun({
		...buildRunEntry({
			sessionId: "tunnel-owner",
			projectPrefix: "demo",
			projectName: "demo",
			root,
			isWorktree: false,
		}),
		apps: [served("api", 4100), served("web", 4999)],
	});
	const opened: string[] = [];
	const coordinator = createTunnelCoordinator(
		env,
		{
			resolveExposeTargets,
			stopPublicTunnels,
			startPublicTunnels: async (targets) => {
				opened.push(...targets.map((target) => target.name));
				return [];
			},
		},
		{ exposeRequested: true },
	);

	try {
		await coordinator.planExpose({
			exposeValue: undefined,
			appsRequested: false,
			selectedAppNames: new Set(["api", "web"]),
			startAppNames: new Set(),
			reusedAppNames: new Set(["api", "web"]),
		});
		await coordinator.openOwnedTunnels();

		expect(coordinator.inheritsPublicUrls()).toBe(true);
		expect(publicUrls).toEqual({ api: "https://api.trycloudflare.com" });
		expect(opened).toEqual(["web"]);
	} finally {
		await retireRuns(["tunnel-owner"]);
		rmSync(root, { recursive: true, force: true });
	}
});
