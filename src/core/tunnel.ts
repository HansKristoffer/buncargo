import type {
	AppConfig,
	DevEnvironment,
	PublicTunnelHandle,
	ServiceConfig,
} from "../types";
import { abortableSleep } from "./deadline";
import { toPortMap } from "./ports";
import { startQuickTunnel } from "./quick-tunnel";
import { exposeTunnelStaggerMs } from "./runtime-flags";

export interface PublicExposeTarget {
	kind: "service" | "app";
	name: string;
	port: number;
}

export type PublicTunnel = PublicTunnelHandle;

function parseExposeNames(exposeValue?: string): Set<string> | null {
	if (exposeValue === undefined) return null;
	const names = exposeValue
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return new Set(names);
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
		const port = toPortMap(env.ports)[name];
		if (port === undefined) continue;
		const target: PublicExposeTarget = { kind: "service", name, port };
		knownTargets.set(name, target);
		if (config.expose === true) {
			enabledTargets.set(name, target);
		}
	}

	for (const [name, config] of Object.entries(env.apps)) {
		const port = toPortMap(env.ports)[name];
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

/**
 * Open a Cloudflare quick tunnel to each target, one after another with a
 * pause between them: trycloudflare.com rate-limits a burst. Any failure, or
 * `signal` firing, closes the tunnels already open.
 */
export async function startPublicTunnels(
	targets: PublicExposeTarget[],
	options: { signal?: AbortSignal } = {},
): Promise<PublicTunnel[]> {
	const { signal } = options;
	const staggerMs = exposeTunnelStaggerMs();
	const tunnels: PublicTunnel[] = [];
	try {
		for (const [index, target] of targets.entries()) {
			signal?.throwIfAborted();
			if (index > 0 && staggerMs > 0) await abortableSleep(staggerMs, signal);
			const localUrl = `http://localhost:${target.port}`;
			// Resolves once cloudflared has printed the public URL.
			const tunnel = await startQuickTunnel({ url: localUrl, signal });
			tunnels.push({
				kind: target.kind,
				name: target.name,
				localUrl,
				publicUrl: (await tunnel.getURL()).replace(/\/$/, ""),
				close: tunnel.close,
			});
		}
		signal?.throwIfAborted();
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

/**
 * `current` without the URLs `removed` set: a key whose value has changed
 * since (an app printed a new one) is someone else's and stays.
 */
export function withoutPublicUrls(
	current: Readonly<Record<string, string>>,
	removed: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(current).filter(([key, url]) => removed[key] !== url),
	);
}
