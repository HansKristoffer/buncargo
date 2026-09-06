import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { abortableSleep, withSignal } from "./deadline";
import { startQuickTunnel } from "./quick-tunnel";
import { exposeTunnelStaggerMs } from "./runtime-flags";

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
		signal?: AbortSignal;
		start?: (input: {
			url: string;
			signal?: AbortSignal;
		}) => Promise<TunnelBackendResult | undefined>;
	} = {},
): Promise<PublicTunnel[]> {
	const start: NonNullable<typeof options.start> =
		options.start ?? ((input) => startQuickTunnel(input));
	const staggerMs = exposeTunnelStaggerMs();

	const tunnels: PublicTunnel[] = [];
	try {
		let index = 0;
		for (const target of targets) {
			options.signal?.throwIfAborted();
			if (index > 0 && staggerMs > 0) {
				await abortableSleep(staggerMs, options.signal);
			}
			index += 1;
			const localUrl = `http://localhost:${target.port}`;
			const starting = start({ url: localUrl, signal: options.signal });
			// A custom callback may ignore cancellation. Stop any late result
			// without letting it resurrect a cancelled startup.
			void starting
				.then((late) => {
					if (late && options.signal?.aborted) return toCloseFn(late)();
				})
				.catch(() => {});
			const tunnel = options.signal
				? await withSignal(starting, options.signal)
				: await starting;
			if (tunnel === undefined) {
				throw new Error(
					`Tunnel for "${target.name}" could not be started (tunnel backend returned no instance)`,
				);
			}
			// Own the returned backend before awaiting its URL; a URL rejection
			// otherwise skips this tunnel when the outer catch cleans up.
			const owned: PublicTunnel = {
				kind: target.kind,
				name: target.name,
				localUrl,
				publicUrl: "",
				close: toCloseFn(tunnel),
			};
			tunnels.push(owned);
			const pendingUrl = resolvePublicUrl(tunnel);
			const rawPublicUrl = options.signal
				? await withSignal(pendingUrl, options.signal)
				: await pendingUrl;
			if (!rawPublicUrl) {
				throw new Error(
					`Tunnel for "${target.name}" did not provide a public URL`,
				);
			}
			owned.publicUrl = rawPublicUrl.replace(/\/$/, "");
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
