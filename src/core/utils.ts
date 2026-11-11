import { applyIntegrations } from "../config/integrations";
import type {
	AppConfig,
	ConfigEnvVarNames,
	EnvValues,
	GetEnvVarValue,
	HostsOptionsLike,
	ServiceConfig,
} from "../types";
import {
	type CheckoutConfig,
	type CheckoutView,
	namedHostsRuntime,
	namedUrls,
	readLiveNamedUrls,
	resolveCheckoutView,
	sharedEnv,
} from "./checkout-view";
import { unallocatedPortsMessage } from "./port-exhaustion";
import { asComputedUrls, findMonorepoRoot } from "./ports";
import { readLiveCapturesSync } from "./run-registry";

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
	// `apps` is typed by the config's own definitions, which name app keys
	// only: what each holds is an `AppConfig`, as validation ensures.
	const { applied, view } = checkoutViewFor(config as AnyCheckoutConfig, root);

	// Live state is read on every call: a run that starts or ends between two
	// loads of a config changes it.
	const live = readLiveNamedUrls(root, view.hostPlan, view.portPlan.ports);
	const hosts = namedHostsRuntime(applied.options?.hosts, view.hostPlan, live);
	const served = live?.hostnames ? new Set(live.hostnames) : undefined;
	const urls = asComputedUrls(namedUrls(view.plainUrls, hosts, served));
	const envVars = sharedEnv(
		{ ...view, config: applied, portOffset: view.portPlan.offset, urls },
		{ publicUrls: {}, captured: readLiveCapturesSync(root), hosts },
	);
	const value = envVars[name];

	// Log frontend port for Vibe Kanban detection
	if (log && name === "VITE_PORT" && typeof value === "number") {
		logFrontendPort(value);
	}

	return value as GetEnvVarValue<TEnv, TName>;
}

type AnyCheckoutConfig = CheckoutConfig<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

/**
 * The last view each config resolved to, with the environment and root it
 * was resolved under: a `vite.config.ts` asking for several names reads the
 * port plan, env files and overrides once. The flags and the config's own
 * callbacks read `process.env`, so a changed environment resolves again.
 */
const views = new WeakMap<
	AnyCheckoutConfig,
	{
		key: string;
		applied: AnyCheckoutConfig;
		view: CheckoutView<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>;
	}
>();

function checkoutViewFor(config: AnyCheckoutConfig, root: string) {
	const environment = Object.entries(process.env).sort(([a], [b]) =>
		a < b ? -1 : 1,
	);
	const key = JSON.stringify([root, environment]);
	const cached = views.get(config);
	if (cached?.key === key) return cached;

	// What a run sees: integrations add apps, services, env and the primary
	// app (Shopify's frontend) before anything is computed.
	const applied = applyIntegrations(config, { root });
	const view = resolveCheckoutView(applied, root);
	// Read before this checkout's first run, with every block claimed: the
	// value points at another checkout's block. Said, not thrown, as for `env`.
	if (view.portPlan.provenance === "unallocated")
		console.warn(unallocatedPortsMessage(root));
	const entry = { key, applied, view };
	views.set(config, entry);
	return entry;
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
