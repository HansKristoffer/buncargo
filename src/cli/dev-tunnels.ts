import type {
	PublicExposeTarget,
	PublicTunnel,
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "../core/tunnel";
import type {
	AppConfig,
	ComputedPublicUrls,
	DevEnvironment,
	DevEnvironmentTunnelLog,
	ServiceConfig,
} from "../types";
import { CliError } from "./errors";
import * as log from "./log";
import {
	loadReusableTunnelApps,
	removeTunnelRegistryEntries,
	type TunnelRegistryEntry,
	upsertTunnelRegistryEntries,
} from "./tunnel-registry";

/** Injectable so tests can drive the expose flow without cloudflared. */
export interface TunnelApi {
	resolveExposeTargets: typeof resolveExposeTargets;
	startPublicTunnels: typeof startPublicTunnels;
	stopPublicTunnels: typeof stopPublicTunnels;
}

export interface PlanExposeInput {
	/** Raw `--expose[=a,b]` value; undefined means "everything exposable". */
	exposeValue: string | undefined;
	appsRequested: boolean;
	selectedAppNames: Set<string>;
	startAppNames: Set<string>;
	reusedAppNames: Set<string>;
}

export interface DevTunnelCoordinator<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	/**
	 * Resolve `--expose` into the tunnels this run must open, inheriting public
	 * URLs from reused apps. Throws `CliError` on an unusable selection.
	 */
	planExpose(input: PlanExposeInput): Promise<void>;
	/** Open the planned tunnels, register them, and log the environment. */
	openOwnedTunnels(): Promise<void>;
	hasPendingTargets(): boolean;
	/** Stop owned tunnels and drop their registry entries. */
	stop(): Promise<void>;
	readonly env: DevEnvironment<TServices, TApps>;
}

export function createTunnelCoordinator<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	tunnelApi: TunnelApi,
	options: { exposeRequested: boolean },
): DevTunnelCoordinator<TServices, TApps> {
	const combinedTunnelLogs: DevEnvironmentTunnelLog[] = [];
	const inheritedPublicUrls: Record<string, string> = {};
	let pendingTargets: PublicExposeTarget[] = [];
	let tunnels: PublicTunnel[] = [];
	let ownedRegistryEntries: TunnelRegistryEntry[] = [];

	/**
	 * Public URLs here come from `--expose` names and the tunnel registry, so
	 * this module only ever knows them as strings. Converting once keeps
	 * `setPublicUrls` typo-checked for programmatic callers.
	 */
	function asPublicUrls(
		urls: Record<string, string>,
	): ComputedPublicUrls<TServices, TApps> {
		return urls as ComputedPublicUrls<TServices, TApps>;
	}

	function parseExposeNames(
		exposeValue: string | undefined,
	): string[] | undefined {
		if (exposeValue === undefined) return undefined;
		return exposeValue
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
	}

	async function inheritReusedPublicUrls(appNames: string[]): Promise<void> {
		if (appNames.length === 0) return;
		const reused = await loadReusableTunnelApps(env.root, {
			appNames,
			ports: env.ports,
		});
		Object.assign(inheritedPublicUrls, reused.publicUrls);
		combinedTunnelLogs.push(...reused.tunnels);
		if (reused.tunnels.length > 0) {
			log.info(
				`ℹ Reusing public URL${reused.tunnels.length > 1 ? "s" : ""} for: ${reused.tunnels
					.map((tunnel) => tunnel.name)
					.join(", ")}`,
			);
		}
		if (reused.missingAppNames.length > 0) {
			log.warn(
				`No reusable public URL found for: ${reused.missingAppNames.join(", ")}`,
			);
		}
	}

	async function planExpose(input: PlanExposeInput): Promise<void> {
		const {
			exposeValue,
			appsRequested,
			selectedAppNames,
			startAppNames,
			reusedAppNames,
		} = input;

		const { targets, unknownNames, notEnabledNames } =
			tunnelApi.resolveExposeTargets(env, exposeValue);

		if (unknownNames.length > 0) {
			throw new CliError(
				`Unknown expose target${unknownNames.length > 1 ? "s" : ""}: ${unknownNames.join(", ")}`,
			);
		}
		if (notEnabledNames.length > 0) {
			throw new CliError(
				`Target${notEnabledNames.length > 1 ? "s" : ""} missing expose: true: ${notEnabledNames.join(", ")}`,
				[
					"Mark these in dev.config.ts with expose: true or remove them from --expose.",
				],
			);
		}

		const explicitNames = parseExposeNames(exposeValue);
		if (appsRequested && explicitNames) {
			const excluded = explicitNames.filter(
				(name) => env.apps[name] !== undefined && !selectedAppNames.has(name),
			);
			if (excluded.length > 0) {
				throw new CliError(
					`Expose target${excluded.length > 1 ? "s" : ""} not included in --apps: ${excluded.join(", ")}`,
					["Add these apps to --apps or remove them from --expose."],
				);
			}
		}

		const scopedTargets = appsRequested
			? targets.filter(
					(target) =>
						target.kind === "service" || selectedAppNames.has(target.name),
				)
			: targets;

		await inheritReusedPublicUrls(
			scopedTargets
				.filter(
					(target) => target.kind === "app" && reusedAppNames.has(target.name),
				)
				.map((target) => target.name),
		);

		const liveTargets = scopedTargets.filter(
			(target) =>
				target.kind === "service" ||
				startAppNames.has(target.name) ||
				reusedAppNames.has(target.name),
		);
		if (liveTargets.length === 0 && combinedTunnelLogs.length === 0) {
			throw new CliError(
				"No expose targets selected. Add expose: true to services/apps or pass names with --expose=<name>.",
			);
		}

		env.setPublicUrls(asPublicUrls(inheritedPublicUrls));
		pendingTargets = liveTargets.filter(
			(target) =>
				!(
					target.kind === "app" &&
					typeof inheritedPublicUrls[target.name] === "string"
				),
		);
	}

	async function openOwnedTunnels(): Promise<void> {
		if (pendingTargets.length === 0) {
			if (options.exposeRequested) {
				env.logInfo("Dev Environment", combinedTunnelLogs);
			}
			return;
		}

		tunnels = await tunnelApi.startPublicTunnels(pendingTargets);
		env.setPublicUrls(
			asPublicUrls({
				...inheritedPublicUrls,
				...Object.fromEntries(
					tunnels.map((tunnel) => [tunnel.name, tunnel.publicUrl] as const),
				),
			}),
		);

		ownedRegistryEntries = tunnels
			.filter((tunnel) => tunnel.kind === "app")
			.map((tunnel) => ({
				kind: "app" as const,
				name: tunnel.name,
				publicUrl: tunnel.publicUrl,
				localUrl: tunnel.localUrl,
				port: env.ports[tunnel.name] ?? 0,
				pid: process.pid,
				updatedAt: new Date().toISOString(),
			}));
		if (ownedRegistryEntries.length > 0) {
			await upsertTunnelRegistryEntries(env.root, ownedRegistryEntries);
		}

		combinedTunnelLogs.push(...tunnels);
		env.logInfo("Dev Environment", combinedTunnelLogs);
		pendingTargets = [];
	}

	async function stop(): Promise<void> {
		env.clearPublicUrls();
		const tunnelsToStop = tunnels;
		const entriesToRemove = ownedRegistryEntries.map((entry) => ({
			kind: entry.kind,
			name: entry.name,
			pid: entry.pid,
		}));
		tunnels = [];
		ownedRegistryEntries = [];
		try {
			if (tunnelsToStop.length > 0) {
				await tunnelApi.stopPublicTunnels(tunnelsToStop);
			}
		} finally {
			if (entriesToRemove.length > 0) {
				await removeTunnelRegistryEntries(env.root, entriesToRemove);
			}
		}
	}

	return {
		env,
		planExpose,
		openOwnedTunnels,
		hasPendingTargets: () => pendingTargets.length > 0,
		stop,
	};
}
