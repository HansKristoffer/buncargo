import { applyIntegrations } from "../config/integrations";
import type {
	AppConfig,
	ConfigEnvVarNames,
	EnvValues,
	EnvVarsBuilder,
	GetEnvVarValue,
	HostsOptionsLike,
	ServiceConfig,
} from "../types";
import { buildSharedEnvValues, mergeSharedEnvWithOverlay } from "./env";
import { loadEnvInput } from "./env-input";
import { applyEnvOverrides, readEnvOverrides } from "./env-overrides";
import { applyHostPlanToUrls, planNamedHosts } from "./hosts/plan";
import { readServedTailscaleUrlsSync } from "./hosts/tailscale-serve";
import { getLocalIp } from "./network";
import { resolvePortPlan } from "./port-allocation";
import {
	asComputedLoopbackUrls,
	asComputedPorts,
	asComputedUrls,
	computeDevIdentity,
	computeLoopbackUrls,
	computeUrls,
	findMonorepoRoot,
} from "./ports";
import { hostsMode, urlHostOverride } from "./runtime-flags";

/**
 * Core utility functions shared across modules.
 */

// Re-exported because `buncargo/core/utils` is a published entry point.
export { promiseTimeout as sleep } from "hanzio";

// ═══════════════════════════════════════════════════════════════════════════
// Vibe Kanban Integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Log the frontend port in a format that Vibe Kanban can detect.
 * This is used to communicate the dev server port to external tools.
 *
 * @param port - The port number the frontend is running on
 */
export function logFrontendPort(port: number | undefined): void {
	console.log(`using_frontend_port:${port}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Config-based Env Var Helper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get an environment variable value from the config.
 * Computes the shared env surface from services/apps.
 *
 * Overlay keys returned by `config.env` are valid names and keep the type the
 * callback declared (`getEnvVar(config, "VITE_PORT")` is `number` when the
 * overlay sets `VITE_PORT: ports.platform`).
 *
 * @param config - The dev config object (from defineDevConfig)
 * @param name - The environment variable name
 * @param options - Optional settings (log for Vibe Kanban detection)
 *
 * @example
 * ```typescript
 * // In vite.config.ts
 * import { getEnvVar } from 'buncargo'
 * import config from '../../dev.config'
 *
 * export default defineConfig(async ({ command }) => {
 *   const isDev = command === 'serve'
 *   const webPort = isDev ? getEnvVar(config, 'WEB_PORT') : undefined
 *   const apiUrl = getEnvVar(config, 'API_URL')
 *   const vitePort = getEnvVar(config, 'VITE_PORT')
 *   return {
 *     server: { port: webPort ?? vitePort, strictPort: true }
 *   }
 * })
 * ```
 */
export function getEnvVar<
	TServices extends Record<string, ServiceConfig>,
	TApps extends object,
	TEnv extends EnvValues,
	TName extends ConfigEnvVarNames<TServices, TApps, TEnv> & string,
>(
	config: {
		projectPrefix: string;
		services: TServices;
		apps?: TApps;
		env?: (...args: never[]) => TEnv;
		options?: {
			envFiles?: readonly import("../types").EnvInputFile[];
			worktreeIsolation?: boolean;
			hosts?: boolean | HostsOptionsLike;
			primaryApp?: string;
		};
	},
	name: TName,
	options: { log?: boolean } = {},
): GetEnvVarValue<TEnv, TName> {
	const { log = true } = options;
	const root = findMonorepoRoot();
	// What a run sees: integrations add apps, services, env and the primary
	// app (Shopify's frontend) before anything is computed.
	const applied = applyIntegrations(config, { root });
	const identity = computeDevIdentity({
		projectPrefix: applied.projectPrefix,
		root,
		worktreeIsolation: applied.options?.worktreeIsolation,
	});
	const services = applied.services;
	const apps = applied.apps as Record<string, AppConfig> | undefined;
	const portPlan = resolvePortPlan({
		projectPrefix: applied.projectPrefix,
		projectName: identity.projectName,
		root,
		services,
		apps,
		worktreeName: identity.worktreeSuffix,
		worktreeIsolation: applied.options?.worktreeIsolation,
		persist: false,
		// A read, not an allocation. There is no runtime in scope here either -
		// resolving one would import the backends that import this module back -
		// so a probe could not tell this project's own service container from a
		// stranger, and would answer with a shifted port nothing is listening on.
		probeConflicts: false,
	});
	const localIp = getLocalIp();

	const portMap = portPlan.ports;
	const mode = hostsMode();
	const hostPlan =
		mode === "loopback" && applied.options?.hosts
			? planNamedHosts({
					projectPrefix: applied.projectPrefix,
					worktreeSuffix: identity.worktreeSuffix,
					apps,
					services,
					ports: portMap,
					hosts: applied.options.hosts,
					// The bare hostname is the primary app's, as in a run.
					primaryApp: applied.options.primaryApp,
				})
			: undefined;
	const urlMap = computeUrls(
		services,
		apps,
		portMap,
		localIp,
		urlHostOverride(),
	);
	if (hostPlan && hostPlan.length > 0) {
		applyHostPlanToUrls(urlMap, hostPlan);
	}
	// Tailscale URLs exist only once a run serves them: what that run recorded.
	if (mode === "tailscale" && applied.options?.hosts) {
		Object.assign(urlMap, readServedTailscaleUrlsSync(root, portMap));
	}

	type Apps = NonNullable<typeof apps>;
	const ports = asComputedPorts<typeof services, Apps>(portMap);
	const urls = asComputedUrls<typeof services, Apps>(urlMap);
	// Computed from the same ports, so this survives the host-plan rewrite above.
	const loopbackUrls = asComputedLoopbackUrls<typeof services, Apps>(
		computeLoopbackUrls(services, apps, portMap),
	);

	const shared = buildSharedEnvValues({
		projectName: identity.projectName,
		services,
		ports,
		urls,
		loopbackUrls,
		publicUrls: {},
	});
	const overrides = readEnvOverrides(root);
	const inputEnv = loadEnvInput(
		root,
		applied.options?.envFiles,
		process.env,
		overrides,
	);
	const envVars = mergeSharedEnvWithOverlay(
		{ ...(applied.options?.envFiles ? inputEnv : {}), ...shared },
		applied.env as
			EnvVarsBuilder<typeof services, NonNullable<typeof apps>> | undefined,
		ports,
		urls,
		{
			env: inputEnv,
			projectName: identity.projectName,
			localIp,
			portOffset: portPlan.offset,
			publicUrls: {},
			loopbackUrls,
		},
	);

	applyEnvOverrides(envVars as Record<string, string>, overrides, inputEnv);
	const value = envVars[name];

	// Log frontend port for Vibe Kanban detection
	if (log && name === "VITE_PORT" && typeof value === "number") {
		logFrontendPort(value);
	}

	return value as GetEnvVarValue<TEnv, TName>;
}

/**
 * Log the API URL in a format that tools can detect.
 * This is used by Expo and other tools to find the API server.
 *
 * @param url - The API URL
 */
export function logApiUrl(url: string): void {
	console.log(`using_api_url:${url}`);
}
