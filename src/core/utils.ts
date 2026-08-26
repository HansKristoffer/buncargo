import type {
	AppConfig,
	ComputedPorts,
	ComputedUrls,
	ConfigEnvVarNames,
	DevConfig,
	ServiceConfig,
} from "../types";
import { buildSharedEnvValues, mergeSharedEnvWithOverlay } from "./env";
import { applyHostPlanToUrls, planNamedHosts } from "./hosts/plan";
import { getLocalIp } from "./network";
import { resolvePortPlan } from "./port-allocation";
import { computeDevIdentity, computeUrls, findMonorepoRoot } from "./ports";
import { isHostsForcedOff } from "./runtime-flags";

/**
 * Core utility functions shared across modules.
 */

/**
 * Sleep for a given number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 *   return {
 *     server: { port: webPort, strictPort: true }
 *   }
 * })
 * ```
 */
export function getEnvVar<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TName extends ConfigEnvVarNames<TServices, TApps>,
>(
	config: DevConfig<TServices, TApps>,
	name: TName,
	options: { log?: boolean } = {},
): string | number | undefined {
	const { log = true } = options;
	const root = findMonorepoRoot();
	const identity = computeDevIdentity({
		projectPrefix: config.projectPrefix,
		root,
		worktreeIsolation: config.options?.worktreeIsolation,
	});
	const portPlan = resolvePortPlan({
		projectPrefix: config.projectPrefix,
		projectName: identity.projectName,
		root,
		services: config.services,
		apps: config.apps,
		worktreeName: identity.worktreeSuffix,
		worktreeIsolation: config.options?.worktreeIsolation,
		persist: false,
	});
	const localIp = getLocalIp();

	const ports = portPlan.ports as ComputedPorts<TServices, TApps>;
	const hostPlan =
		!isHostsForcedOff() && config.options?.hosts
			? planNamedHosts({
					projectPrefix: config.projectPrefix,
					worktreeSuffix: identity.worktreeSuffix,
					apps: config.apps,
					services: config.services,
					ports,
					hosts: config.options.hosts,
				})
			: undefined;
	const urls = computeUrls(
		config.services,
		config.apps,
		ports,
		localIp,
	) as ComputedUrls<TServices, TApps>;
	if (hostPlan && hostPlan.length > 0) {
		applyHostPlanToUrls(urls as Record<string, string>, hostPlan);
	}

	const shared = buildSharedEnvValues({
		projectName: identity.projectName,
		services: config.services,
		ports,
		urls,
		publicUrls: {},
	});
	const envVars = mergeSharedEnvWithOverlay(shared, config.env, ports, urls, {
		projectName: identity.projectName,
		localIp,
		portOffset: portPlan.offset,
		publicUrls: {},
	});

	const value = envVars[name];

	// Log frontend port for Vibe Kanban detection
	if (log && name === "VITE_PORT" && typeof value === "number") {
		logFrontendPort(value);
	}

	return value;
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

/**
 * Log the Expo API URL in a format that tools can detect.
 * This is typically the local IP address for mobile device connectivity.
 *
 * @param url - The Expo API URL (usually http://<local-ip>:<port>)
 */
export function logExpoApiUrl(url: string): void {
	console.log(`using_expo_api_url:${url}`);
}
