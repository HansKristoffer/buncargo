import { applyProfileIntegrations } from "../config/integrations";
import { resolveConfig } from "../config/resolve";
import type {
	AnyProfileConfig,
	AppConfig,
	ConfigEnvVarNames,
	EnvValues,
	GetEnvVarValue,
	HostsOptionsLike,
	LinkConfig,
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
import { resolveLinksFromRuns } from "./links";
import { unallocatedPortsMessage } from "./port-exhaustion";
import { asComputedUrls, findMonorepoRoot } from "./ports";
import { readLiveRunsSync } from "./run-registry";

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
 *
 * @example
 * ```typescript
 * // In vite.config.ts
 * import { getEnvVar } from 'buncargo/api'
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
		links?: Readonly<Record<string, LinkConfig>>;
		env?: (...args: never[]) => TEnv;
		profiles?: Readonly<Record<string, AnyProfileConfig>>;
		options?: {
			envFiles?: readonly import("../types").EnvInputFile[];
			worktreeIsolation?: boolean;
			hosts?: boolean | HostsOptionsLike;
			primaryApp?: string;
		};
	},
	name: TName,
	options?: { profile?: string },
): GetEnvVarValue<TEnv, TName> {
	const root = findMonorepoRoot();
	// `apps` is typed by the config's own definitions, which name app keys
	// only: what each holds is an `AppConfig`, as validation ensures.
	const { resolved, view } = checkoutViewFor(
		config as AnyConfig,
		root,
		options?.profile,
	);

	// Live state is read once per call: a run that starts or ends between two
	// loads of a config changes it.
	const live = readLiveNamedUrls(root, view.hostPlan, view.portPlan.ports);
	const hosts = namedHostsRuntime(resolved.options?.hosts, view.hostPlan, live);
	const served = live?.hostnames ? new Set(live.hostnames) : undefined;
	const urls = asComputedUrls(namedUrls(view.plainUrls, hosts, served));
	const liveRuns = readLiveRunsSync();
	const { links } = resolveLinksFromRuns(root, resolved.links, liveRuns);
	const captured: Record<string, string> = Object.assign(
		{},
		...liveRuns
			.filter((run) => run.root === root)
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
			.map((run) => run.captures ?? {}),
	);

	const envVars = sharedEnv(
		{ ...view, config: resolved, portOffset: view.portPlan.offset, urls },
		{ publicUrls: {}, captured, hosts, links },
	);
	return envVars[name] as GetEnvVarValue<TEnv, TName>;
}

type AnyConfig = Omit<
	CheckoutConfig<Record<string, ServiceConfig>, Record<string, AppConfig>>,
	"services" | "apps"
> & {
	services: Record<string, ServiceConfig>;
	apps?: Record<string, AppConfig>;
};

type EnvSnapshot = Readonly<Record<string, string | undefined>>;

function sameEnv(a: EnvSnapshot, b: EnvSnapshot): boolean {
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
	);
}

/**
 * The last view each config resolved to, with the environment and root it
 * was resolved under: a `vite.config.ts` asking for several names reads the
 * port plan, env files and overrides once. The flags and the config's own
 * callbacks read `process.env`, so a changed environment resolves again.
 */
const views = new WeakMap<
	AnyConfig,
	{
		root: string;
		profile: string | undefined;
		env: EnvSnapshot;
		resolved: CheckoutConfig<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>;
		view: CheckoutView<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>;
	}
>();

function checkoutViewFor(
	config: AnyConfig,
	root: string,
	profile: string | undefined,
) {
	const cached = views.get(config);
	if (
		cached &&
		cached.root === root &&
		cached.profile === profile &&
		sameEnv(cached.env, process.env)
	) {
		return cached;
	}

	// What a run sees: integrations add apps, services, env and the primary
	// app (Shopify's frontend) before anything is computed.
	const applied = applyProfileIntegrations(config, { root, profile });
	const resolved = resolveConfig(
		applied,
		profile !== undefined ? { profile } : undefined,
	);
	const view = resolveCheckoutView(resolved, root);

	// Read before this checkout's first run, with every block claimed: the
	// value points at another checkout's block. Said, not thrown, as for `env`.
	if (view.portPlan.provenance === "unallocated") {
		console.warn(unallocatedPortsMessage(root));
	}

	const entry = { root, profile, env: { ...process.env }, resolved, view };
	views.set(config, entry);
	return entry;
}
