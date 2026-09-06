import { expect, it } from "bun:test";
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
