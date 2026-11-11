import { statSync } from "node:fs";
import { resolve } from "node:path";
import { withDeadline } from "../core/deadline";
import { waitForDevServers } from "../core/network";
import {
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
	withoutPublicUrls,
} from "../core/tunnel";
import { assertOnlyAppNames, pickApps, resolveSelectedApps } from "../planning";
import type {
	DevEnvironment,
	DevServerPids,
	OpenPublicTunnelsOptions,
	OpenPublicTunnelsResult,
	ResolvedApp,
} from "../types";
import type { AnyApps, AnyServices, DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import type { AppPipeline, Prepared } from "./pipeline";

/** Validate all selected working directories before any startup mutation. */
export function assertAppWorkingDirectories(
	apps: Record<string, ResolvedApp>,
	root: string,
	production = false,
): void {
	for (const [name, app] of Object.entries(apps)) {
		if (
			typeof (production
				? (app.prodCommand ?? app.devCommand)
				: app.devCommand) !== "string"
		)
			continue;
		const cwd = resolve(root, app.cwd ?? ".");
		let directory = false;
		try {
			directory = statSync(cwd).isDirectory();
		} catch {
			/* Report the field below. */
		}
		if (!directory)
			throw new Error(
				`apps.${name}.cwd is not an accessible directory: ${cwd}`,
			);
	}
}

/**
 * `beforeServers`/`afterServers` for `start()` and the CLI alike, told the
 * prepared selection and bounded like every other hook.
 */
export function createServerHookRunner(
	ctx: DevEnvContext,
	envVars: DevEnvVarsApi,
): (phase: "before" | "after", signal?: AbortSignal) => Promise<void> {
	return async (phase, signal) => {
		const hook =
			ctx.config.hooks?.[phase === "before" ? "beforeServers" : "afterServers"];
		if (hook)
			await withDeadline(
				(hookSignal) => hook(envVars.getHookContext(hookSignal)),
				600_000,
				signal,
			);
	};
}

export interface DevServersApi {
	startServersOnly(options?: {
		signal?: AbortSignal;
		productionBuild?: boolean;
		verbose?: boolean;
		onlyApps?: string[];
	}): Promise<DevServerPids>;
	waitForServersReady(options?: {
		timeout?: number;
		productionBuild?: boolean;
		onlyApps?: string[];
		expandRequired?: boolean;
		logReady?: boolean;
		verbose?: boolean;
		signal?: AbortSignal;
		onAppReady?: (name: string) => void;
	}): Promise<void>;
	openPublicTunnels(
		options?: OpenPublicTunnelsOptions,
	): Promise<OpenPublicTunnelsResult<AnyServices, AnyApps>>;
}

export function createServersApi(
	ctx: DevEnvContext,
	appPipeline: AppPipeline,
): DevServersApi {
	const { apps, services, ports, config } = ctx;

	async function startServersOnly(
		options: {
			signal?: AbortSignal;
			productionBuild?: boolean;
			verbose?: boolean;
			onlyApps?: string[];
		} = {},
	): Promise<DevServerPids> {
		const { productionBuild = false, verbose = true, onlyApps } = options;
		const selected = resolveSelectedApps(apps, onlyApps);

		if (Object.keys(selected.apps).length === 0) {
			return {};
		}

		// Whatever a start prepared, this spawns on its own: no seed beside it.
		const prepared: Prepared = {
			selection: {
				appNames: Object.keys(selected.apps),
				requiredServiceKeys: ctx.selectedServiceKeys,
			},
			apps: selected.apps,
			hasServices: ctx.hasSelectedServices,
			productionBuild,
			verbose,
			watchdog: false,
			seed: { kind: "none" },
		};
		const claimed = await appPipeline.claimApps(prepared, {
			signal: options.signal,
		});
		return appPipeline.spawn(claimed, { signal: options.signal });
	}

	async function waitForServersReady(
		options: {
			productionBuild?: boolean;
			onlyApps?: string[];
			expandRequired?: boolean;
			logReady?: boolean;
			verbose?: boolean;
			signal?: AbortSignal;
			onAppReady?: (name: string) => void;
		} = {},
	): Promise<void> {
		const {
			productionBuild = false,
			onlyApps,
			expandRequired = true,
		} = options;
		const appsToWait =
			onlyApps && !expandRequired
				? Object.fromEntries(
						onlyApps.flatMap((name) => {
							const app = apps[name];
							return app ? [[name, app]] : [];
						}),
					)
				: resolveSelectedApps(apps, onlyApps).apps;
		await waitForDevServers(appsToWait, ports, {
			productionBuild,
			signal: options.signal,
			logReady: options.logReady,
			verbose: options.verbose,
			onAppReady: options.onAppReady,
		});
	}

	async function openPublicTunnels(
		options: OpenPublicTunnelsOptions = {},
	): Promise<OpenPublicTunnelsResult<AnyServices, AnyApps>> {
		const { names, waitForHealthy } = options;
		const exposeList = names?.length ? names.join(",") : undefined;

		if (waitForHealthy?.length) {
			assertOnlyAppNames(Object.keys(apps), waitForHealthy);
			await waitForDevServers(pickApps(apps, waitForHealthy), ports, {
				verbose: config.options?.verbose ?? true,
				productionBuild: false,
				signal: options.signal,
			});
		}

		const { targets, unknownNames, notEnabledNames } = resolveExposeTargets(
			{ services, apps, ports } as DevEnvironment<AnyServices, AnyApps>,
			exposeList,
		);

		if (unknownNames.length > 0) {
			throw new Error(`Unknown expose target(s): ${unknownNames.join(", ")}`);
		}
		if (notEnabledNames.length > 0) {
			throw new Error(
				`Target(s) missing expose: true: ${notEnabledNames.join(", ")}`,
			);
		}
		if (targets.length === 0) {
			throw new Error(
				"No expose targets selected. Add expose: true to services/apps or pass names that have expose: true.",
			);
		}

		const tunnels = await startPublicTunnels(targets, {
			signal: options.signal,
		});
		const opened: Record<string, string> = Object.fromEntries(
			tunnels.map((t) => [t.name, t.publicUrl]),
		);
		// Beside the URLs apps printed (`captures`), which are not the tunnels'.
		ctx.setPublicUrls({ ...ctx.publicUrls, ...opened });

		let closed = false;
		async function close(): Promise<void> {
			if (closed) return;
			closed = true;
			await stopPublicTunnels(tunnels);
			ctx.setPublicUrls(withoutPublicUrls(ctx.publicUrls, opened));
		}

		return {
			publicUrls: { ...opened },
			tunnels,
			close,
		};
	}

	return { startServersOnly, waitForServersReady, openPublicTunnels };
}
