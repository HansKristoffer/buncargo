import { anySignal } from "hanzio";
import { findRunsByRoot, type RunEntry } from "../core/run-registry";
import {
	type PublicExposeTarget,
	type PublicTunnel,
	type resolveExposeTargets,
	type startPublicTunnels,
	type stopPublicTunnels,
	withoutPublicUrls,
} from "../core/tunnel";
import type {
	AppConfig,
	ComputedPublicUrls,
	DevEnvironment,
	DevEnvironmentTunnelLog,
	EnvironmentLogSelection,
	ServiceConfig,
} from "../types";
import { CliError } from "./errors";
import * as log from "./log";

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
	selectedServiceNames?: Set<string>;
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
	openOwnedTunnels(signal?: AbortSignal): Promise<void>;
	hasPendingTargets(): boolean;
	/** Whether a reused app's public URL is another run's tunnel. */
	inheritsPublicUrls(): boolean;
	/** Stop owned tunnels and withdraw the public URLs this run set. */
	stop(): Promise<void>;
	readonly env: DevEnvironment<TServices, TApps>;
}

export function createTunnelCoordinator<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	env: DevEnvironment<TServices, TApps>,
	tunnelApi: TunnelApi,
	options: { exposeRequested: boolean; signal?: AbortSignal },
): DevTunnelCoordinator<TServices, TApps> {
	const combinedTunnelLogs: DevEnvironmentTunnelLog[] = [];
	const inheritedPublicUrls: Record<string, string> = {};
	let pendingTargets: PublicExposeTarget[] = [];
	let tunnels: PublicTunnel[] = [];
	// The URLs this run's tunnels set: closing them removes only these, never
	// a URL an app printed (`captures`) beside them.
	let openedPublicUrls: Record<string, string> = {};
	const openingController = new AbortController();
	let opening: Promise<void> | undefined;
	let selection: EnvironmentLogSelection | undefined;

	/**
	 * Public URLs here come from `--expose` names and the run registry, so
	 * this module only ever knows them as strings. Converting once keeps
	 * `setPublicUrls` typo-checked for programmatic callers.
	 */
	function asPublicUrls(
		urls: Record<string, string>,
	): ComputedPublicUrls<TServices, TApps> {
		return urls as ComputedPublicUrls<TServices, TApps>;
	}
	/** `env.setPublicUrls` replaces the map: keep what apps printed. */
	function addPublicUrls(urls: Record<string, string>): void {
		const current = env.publicUrls as Record<string, string>;
		env.setPublicUrls(asPublicUrls({ ...current, ...urls }));
	}

	async function inheritReusedPublicUrls(appNames: string[]): Promise<void> {
		if (appNames.length === 0) return;
		const reused = reusablePublicUrls(
			await findRunsByRoot(env.root),
			appNames,
			env.ports as Record<string, number>,
		);
		const names = reused.map((tunnel) => tunnel.name);
		for (const tunnel of reused)
			inheritedPublicUrls[tunnel.name] = tunnel.publicUrl;
		combinedTunnelLogs.push(...reused);
		if (reused.length > 0) {
			const plural = reused.length > 1 ? "s" : "";
			log.info(`ℹ Reusing public URL${plural} for: ${names.join(", ")}`);
		}
		const missing = appNames.filter((name) => !names.includes(name));
		if (missing.length > 0) {
			log.warn(`No reusable public URL found for: ${missing.join(", ")}`);
		}
	}

	async function planExpose(input: PlanExposeInput): Promise<void> {
		const {
			exposeValue,
			appsRequested,
			selectedAppNames,
			selectedServiceNames,
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

		// With explicit names and no unknown or disabled one, the targets are exactly those names.
		if (appsRequested && exposeValue !== undefined) {
			const excluded = targets
				.filter(
					(target) =>
						target.kind === "app" && !selectedAppNames.has(target.name),
				)
				.map((target) => target.name);
			if (excluded.length > 0) {
				throw new CliError(
					`Expose target${excluded.length > 1 ? "s" : ""} not included in --apps: ${excluded.join(", ")}`,
					["Add these apps to --apps or remove them from --expose."],
				);
			}
		}

		const selectedTargets = selectedServiceNames
			? targets.filter(
					(target) =>
						target.kind !== "service" || selectedServiceNames.has(target.name),
				)
			: targets;
		const scopedTargets = appsRequested
			? selectedTargets.filter(
					(target) =>
						target.kind === "service" || selectedAppNames.has(target.name),
				)
			: selectedTargets;

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

		selection = {
			appNames: [...selectedAppNames],
			requiredServiceKeys: [
				...(selectedServiceNames ?? Object.keys(env.services)),
			],
		};
		addPublicUrls(inheritedPublicUrls);
		pendingTargets = liveTargets.filter(
			(target) =>
				!(
					target.kind === "app" &&
					typeof inheritedPublicUrls[target.name] === "string"
				),
		);
	}

	function openOwnedTunnels(signal?: AbortSignal): Promise<void> {
		// Shared while it is under way; a failed or cancelled open is
		// forgotten, its targets still pending, so the next call tries again.
		opening ??= performOpen(
			anySignal(openingController.signal, signal, options.signal),
		).catch((error: unknown) => {
			opening = undefined;
			throw error;
		});
		return opening;
	}

	async function performOpen(signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (pendingTargets.length === 0) {
			if (options.exposeRequested) {
				env.logInfo("Dev Environment", combinedTunnelLogs, selection);
			}
			return;
		}

		const started = await tunnelApi.startPublicTunnels(pendingTargets, {
			signal,
		});
		if (signal.aborted) {
			// Opened while being cancelled: closed here, never left for a
			// retry to replace.
			await tunnelApi.stopPublicTunnels(started);
			signal.throwIfAborted();
		}
		tunnels = started;
		openedPublicUrls = Object.fromEntries(
			tunnels.map((tunnel) => [tunnel.name, tunnel.publicUrl] as const),
		);
		addPublicUrls(openedPublicUrls);

		combinedTunnelLogs.push(...tunnels);
		env.logInfo("Dev Environment", combinedTunnelLogs, selection);
		pendingTargets = [];
	}

	async function stop(): Promise<void> {
		openingController.abort(new Error("Tunnel startup stopped"));
		await opening?.catch(() => {});
		const current = env.publicUrls as Record<string, string>;
		env.setPublicUrls(
			asPublicUrls(
				withoutPublicUrls(current, {
					...inheritedPublicUrls,
					...openedPublicUrls,
				}),
			),
		);
		openedPublicUrls = {};
		const tunnelsToStop = tunnels;
		tunnels = [];
		if (tunnelsToStop.length > 0) {
			await tunnelApi.stopPublicTunnels(tunnelsToStop);
		}
	}

	return {
		env,
		planExpose,
		openOwnedTunnels,
		hasPendingTargets: () => pendingTargets.length > 0,
		inheritsPublicUrls: () => Object.keys(inheritedPublicUrls).length > 0,
		stop,
	};
}

/**
 * The public URLs live runs of this checkout publish for apps this run
 * reuses. The run serving a reused app is the one whose tunnel reaches it,
 * and its entry is live only while that process (by pid and identity) is,
 * so a URL from a run that ended is never inherited. The port must match:
 * the URL reaches the app on the port it was opened for.
 */
function reusablePublicUrls(
	runs: readonly RunEntry[],
	appNames: readonly string[],
	ports: Record<string, number>,
): DevEnvironmentTunnelLog[] {
	const rows = runs.flatMap((run) => run.apps);
	return appNames.flatMap((name) => {
		const port = ports[name];
		const publicUrl = rows.find(
			(row) =>
				row.name === name && row.port === port && row.publicUrl !== undefined,
		)?.publicUrl;
		if (publicUrl === undefined) return [];
		return [
			{
				kind: "app" as const,
				name,
				localUrl: `http://localhost:${port}`,
				publicUrl,
			},
		];
	});
}
