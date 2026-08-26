import { waitForDevServers } from "../core/network";
import { buildApps, startDevServers } from "../core/process";
import { isCI } from "../core/runtime-flags";
import {
	resolveExposeTargets,
	startPublicTunnels,
	stopPublicTunnels,
} from "../core/tunnel";
import { assertOnlyAppNames, pickApps, resolveSelectedApps } from "../planning";
import type {
	AppConfig,
	ComputedPublicUrls,
	DevEnvironment,
	DevServerPids,
	EnvValues,
	OpenPublicTunnelsOptions,
	OpenPublicTunnelsResult,
	ServiceConfig,
} from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";

function readyTimeout(): number {
	return isCI() ? 120000 : 60000;
}

/**
 * Build (production only), spawn and health-wait a set of apps.
 *
 * Shared by `start()` and `startServers()` so both paths agree on build order,
 * spawn options and the readiness timeout.
 */
export async function startAppServers<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
	options: {
		apps: Record<string, AppConfig>;
		productionBuild: boolean;
		verbose: boolean;
	},
): Promise<DevServerPids> {
	const { apps: appsToStart, productionBuild, verbose } = options;

	if (productionBuild) {
		buildApps(
			appsToStart,
			ctx.root,
			envVars.buildAppEnvVarsMap(appsToStart, true),
			{ verbose },
		);
	}

	const pids = await startDevServers(
		appsToStart,
		ctx.root,
		envVars.buildAppEnvVarsMap(appsToStart, productionBuild),
		ctx.ports,
		{
			verbose,
			productionBuild,
			isCI: isCI(),
			projectName: ctx.projectName,
		},
	);

	await waitForDevServers(appsToStart, ctx.ports, {
		timeout: readyTimeout(),
		verbose,
		productionBuild,
	});

	return pids;
}

export interface DevServersApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	startServersOnly(options?: {
		productionBuild?: boolean;
		verbose?: boolean;
		onlyApps?: Extract<keyof TApps, string>[];
	}): Promise<DevServerPids>;
	waitForServersReady(options?: {
		timeout?: number;
		productionBuild?: boolean;
		onlyApps?: Extract<keyof TApps, string>[];
		expandRequired?: boolean;
	}): Promise<void>;
	openPublicTunnels(
		options?: OpenPublicTunnelsOptions<TServices, TApps>,
	): Promise<OpenPublicTunnelsResult<TServices, TApps>>;
}

export function createServersApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	ctx: DevEnvContext<TServices, TApps, TEnv>,
	envVars: DevEnvVarsApi<TServices, TApps, TEnv>,
): DevServersApi<TServices, TApps> {
	const { apps, services, ports, config } = ctx;

	async function startServersOnly(
		options: {
			productionBuild?: boolean;
			verbose?: boolean;
			onlyApps?: Extract<keyof TApps, string>[];
		} = {},
	): Promise<DevServerPids> {
		const { productionBuild = false, verbose = true, onlyApps } = options;
		const appsToStart = resolveSelectedApps(apps, onlyApps).apps;

		if (Object.keys(appsToStart).length === 0) {
			return {};
		}

		return startAppServers(ctx, envVars, {
			apps: appsToStart,
			productionBuild,
			verbose,
		});
	}

	async function waitForServersReady(
		options: {
			timeout?: number;
			productionBuild?: boolean;
			onlyApps?: Extract<keyof TApps, string>[];
			expandRequired?: boolean;
		} = {},
	): Promise<void> {
		const {
			timeout = 60000,
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
		await waitForDevServers(appsToWait, ports, { timeout, productionBuild });
	}

	async function openPublicTunnels(
		options: OpenPublicTunnelsOptions<TServices, TApps> = {},
	): Promise<OpenPublicTunnelsResult<TServices, TApps>> {
		const { names, waitForHealthy } = options;
		const exposeList = names?.length ? names.join(",") : undefined;

		if (waitForHealthy?.length) {
			assertOnlyAppNames(Object.keys(apps), waitForHealthy);
			await waitForDevServers(pickApps(apps, waitForHealthy), ports, {
				timeout: readyTimeout(),
				verbose: config.options?.verbose ?? true,
				productionBuild: false,
			});
		}

		const { targets, unknownNames, notEnabledNames } = resolveExposeTargets(
			{ services, apps, ports } as DevEnvironment<TServices, TApps>,
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

		const tunnels = await startPublicTunnels(targets);
		ctx.setPublicUrls(
			Object.fromEntries(tunnels.map((t) => [t.name, t.publicUrl])),
		);

		let closed = false;
		async function close(): Promise<void> {
			if (closed) return;
			closed = true;
			await stopPublicTunnels(tunnels);
			ctx.clearPublicUrls();
		}

		return {
			publicUrls: { ...ctx.publicUrls } as ComputedPublicUrls<TServices, TApps>,
			tunnels,
			close,
		};
	}

	return { startServersOnly, waitForServersReady, openPublicTunnels };
}
