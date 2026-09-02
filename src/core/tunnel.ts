import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { startQuickTunnel } from "./quick-tunnel";
import { exposeTunnelStaggerMs } from "./runtime-flags";
import { sleep } from "./sleep";

export interface PublicExposeTarget {
	kind: "service" | "app";
	name: string;
	port: number;
}

export interface PublicTunnel {
	kind: "service" | "app";
	name: string;
	localUrl: string;
	publicUrl: string;
	close: () => Promise<void>;
}

interface TunnelBackendResult {
	getURL?: () => Promise<string>;
	url?: string;
	publicUrl?: string;
	tunnelUrl?: string;
	close?: () => void | Promise<void>;
	stop?: () => void | Promise<void>;
	destroy?: () => void | Promise<void>;
}

function parseExposeNames(exposeValue?: string): Set<string> | null {
	if (exposeValue === undefined) return null;
	const names = exposeValue
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return new Set(names);
}

/** Resolves public origin from tunnel backends (sync fields or untun-style async getURL). */
async function resolvePublicUrl(
	tunnel: TunnelBackendResult,
): Promise<string | null> {
	if (typeof tunnel.getURL === "function") {
		return await tunnel.getURL();
	}
	return tunnel.url ?? tunnel.publicUrl ?? tunnel.tunnelUrl ?? null;
}

function toCloseFn(tunnel: TunnelBackendResult): () => Promise<void> {
	const close = tunnel.close ?? tunnel.stop ?? tunnel.destroy;
	if (!close) return async () => {};
	return async () => {
		await close();
	};
}

export function resolveExposeTargets<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	exposeValue?: string,
): {
	targets: PublicExposeTarget[];
	unknownNames: string[];
	notEnabledNames: string[];
} {
	const requestedNames = parseExposeNames(exposeValue);
	const knownTargets = new Map<string, PublicExposeTarget>();
	const enabledTargets = new Map<string, PublicExposeTarget>();

	for (const [name, config] of Object.entries(env.services)) {
		const port = env.ports[name];
		if (port === undefined) continue;
		const target: PublicExposeTarget = { kind: "service", name, port };
		knownTargets.set(name, target);
		if (config.expose === true) {
			enabledTargets.set(name, target);
		}
	}

	for (const [name, config] of Object.entries(env.apps)) {
		const port = env.ports[name];
		if (port === undefined) continue;
		const target: PublicExposeTarget = { kind: "app", name, port };
		knownTargets.set(name, target);
		if (config.expose === true) {
			enabledTargets.set(name, target);
		}
	}

	if (requestedNames === null) {
		return {
			targets: Array.from(enabledTargets.values()),
			unknownNames: [],
			notEnabledNames: [],
		};
	}

	const unknownNames: string[] = [];
	const notEnabledNames: string[] = [];
	const targets: PublicExposeTarget[] = [];

	for (const name of requestedNames) {
		if (!knownTargets.has(name)) {
			unknownNames.push(name);
			continue;
		}
		const enabledTarget = enabledTargets.get(name);
		if (!enabledTarget) {
			notEnabledNames.push(name);
			continue;
		}
		targets.push(enabledTarget);
	}

	return { targets, unknownNames, notEnabledNames };
}

export async function startPublicTunnels(
	targets: PublicExposeTarget[],
	options: {
		start?: (input: {
			url: string;
		}) => Promise<TunnelBackendResult | undefined>;
	} = {},
): Promise<PublicTunnel[]> {
	const start = options.start ?? ((input) => startQuickTunnel(input));
	const staggerMs = exposeTunnelStaggerMs();

	const tunnels: PublicTunnel[] = [];
	try {
		let index = 0;
		for (const target of targets) {
			if (index > 0 && staggerMs > 0) {
				await sleep(staggerMs);
			}
			index += 1;
			const localUrl = `http://localhost:${target.port}`;
			const tunnel = (await start({
				url: localUrl,
			})) as TunnelBackendResult | undefined;
			if (tunnel === undefined) {
				throw new Error(
					`Tunnel for "${target.name}" could not be started (tunnel backend returned no instance)`,
				);
			}
			const rawPublicUrl = await resolvePublicUrl(tunnel);
			if (!rawPublicUrl) {
				throw new Error(
					`Tunnel for "${target.name}" did not provide a public URL`,
				);
			}
			const publicUrl = rawPublicUrl.replace(/\/$/, "");
			tunnels.push({
				kind: target.kind,
				name: target.name,
				localUrl,
				publicUrl,
				close: toCloseFn(tunnel),
			});
		}
		return tunnels;
	} catch (e) {
		await stopPublicTunnels(tunnels);
		throw e;
	}
}

export async function stopPublicTunnels(
	tunnels: PublicTunnel[],
): Promise<void> {
	await Promise.allSettled(tunnels.map((tunnel) => tunnel.close()));
}
