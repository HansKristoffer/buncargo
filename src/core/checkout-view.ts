import { isDefined } from "hanzio";
import type {
	AppConfig,
	ComputedLoopbackUrls,
	ComputedPorts,
	ComputedPublicUrls,
	ComputedUrls,
	EnvInputFile,
	EnvValues,
	EnvVarsBuilder,
	EnvVarsContext,
	HostsOptionsLike,
	HostsRuntime,
	NamedHost,
	NamedHostsActivation,
	ServiceConfig,
} from "../types";
import { capturedEnv } from "./captured-values";
import { buildSharedEnvValues, mergeSharedEnvWithOverlay } from "./env";
import { type EnvInput, loadEnvInput } from "./env-input";
import { applyEnvOverrides, readEnvOverrides } from "./env-overrides";
import { getCaPath } from "./hosts/mkcert";
import { applyHostPlanToUrls, planNamedHosts } from "./hosts/plan";
import { readLiveNamedHostsSync } from "./hosts/route-owners";
import { readServedTailscaleUrlsSync } from "./hosts/tailscale-serve";
import { getLocalIp } from "./network";
import { type PortPlan, resolvePortPlan } from "./port-allocation";
import {
	asComputedLoopbackUrls,
	asComputedPorts,
	computeDevIdentity,
	computeLoopbackUrls,
	computeUrls,
	type UrlMap,
} from "./ports";
import { hostsMode, urlHostOverride } from "./runtime-flags";
import { workspaceId } from "./workspace-identity";

/** The parts of a config (integrations applied) a checkout view reads. */
export interface CheckoutConfig<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	projectPrefix: string;
	services: TServices;
	apps?: TApps;
	env?: (...args: never[]) => EnvValues;
	options?: {
		envFiles?: readonly EnvInputFile[];
		worktreeIsolation?: boolean;
		hosts?: boolean | HostsOptionsLike;
		primaryApp?: string;
	};
}

/**
 * What a checkout's config resolves to before anything starts: identity,
 * the port plan as on disk, URLs, the named-host plan and the env input.
 * The run and `getEnvVar` both start from it, so they cannot drift.
 */
export interface CheckoutView<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	readonly root: string;
	readonly projectName: string;
	readonly projectSuffix: string | undefined;
	readonly worktree: boolean;
	readonly worktreeSuffix: string | null;
	readonly services: TServices;
	readonly apps: TApps;
	readonly localIp: string;
	readonly workspaceId: string;
	readonly portPlan: PortPlan;
	readonly ports: ComputedPorts<TServices, TApps>;
	/** App and service URLs on their ports, before any named host. */
	readonly plainUrls: UrlMap;
	readonly loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	/** Empty when the config has no `options.hosts`. */
	readonly hostPlan: NamedHost[];
	readonly inputEnv: EnvInput;
	/** `buncargo env set` values, applied on top of every computed environment. */
	readonly envOverrides: Readonly<Record<string, string>>;
}

/**
 * Resolve `config` for the checkout at `root`, reading the port plan, env
 * files and overrides and writing nothing. Every call returns new objects,
 * which the caller may mutate.
 */
export function resolveCheckoutView<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	config: CheckoutConfig<TServices, TApps>,
	root: string,
	options: { suffix?: string } = {},
): CheckoutView<TServices, TApps> {
	const { suffix } = options;
	const identity = computeDevIdentity({
		projectPrefix: config.projectPrefix,
		suffix,
		root,
		worktreeIsolation: config.options?.worktreeIsolation,
	});
	const services = config.services;
	const apps = (config.apps ?? {}) as TApps;
	const portPlan = resolvePortPlan({
		projectPrefix: config.projectPrefix,
		projectName: identity.projectName,
		root,
		services,
		apps,
		suffix,
		worktreeName: identity.worktreeSuffix,
		worktreeIsolation: config.options?.worktreeIsolation,
		persist: false,
		// A read, not an allocation. Without the resolved backend the
		// allocator asks Docker about every port, so this project's own
		// containers look foreign and the answer is a shifted port nothing
		// listens on.
		probeConflicts: false,
	});
	const localIp = getLocalIp();
	const envOverrides = readEnvOverrides(root);
	const hosts = config.options?.hosts;

	return {
		root,
		projectName: identity.projectName,
		projectSuffix: identity.projectSuffix,
		worktree: identity.worktree,
		worktreeSuffix: identity.worktreeSuffix,
		services,
		apps,
		localIp,
		workspaceId: workspaceId(root),
		portPlan,
		ports: asComputedPorts<TServices, TApps>(portPlan.ports),
		plainUrls: computeUrls(
			services,
			apps,
			portPlan.ports,
			localIp,
			urlHostOverride(),
		),
		loopbackUrls: asComputedLoopbackUrls<TServices, TApps>(
			computeLoopbackUrls(services, apps, portPlan.ports),
		),
		hostPlan: hosts
			? planNamedHosts({
					projectPrefix: config.projectPrefix,
					worktreeSuffix: identity.worktreeSuffix,
					apps,
					services,
					ports: portPlan.ports,
					hosts,
					// The bare hostname is the primary app's.
					primaryApp: config.options?.primaryApp,
				})
			: [],
		inputEnv: loadEnvInput(
			root,
			config.options?.envFiles,
			process.env,
			envOverrides,
		),
		envOverrides,
	};
}

/**
 * The named URLs a run of `root` serves right now, entry by entry: in
 * loopback mode each plan entry whose route a live run registered, in
 * Tailscale mode each app the run recorded Tailscale serving. Undefined when
 * none is. Synchronous, for `getEnvVar` inside a user's config.
 */
export function readLiveNamedUrls(
	root: string,
	plan: readonly NamedHost[],
	ports: Readonly<Record<string, number>>,
): NamedHostsActivation | undefined {
	const mode = hostsMode();
	if (mode === "tailscale") {
		const tailscaleUrls = readServedTailscaleUrlsSync(root, ports);
		return Object.keys(tailscaleUrls).length > 0
			? { tailscaleUrls }
			: undefined;
	}
	if (mode === "off") return undefined;
	const hostnames = readLiveNamedHostsSync(root, plan).map(
		(entry) => entry.hostname,
	);
	return hostnames.length > 0 ? { caPath: getCaPath(), hostnames } : undefined;
}

/**
 * A config's named hosts as a run holds them, active with `live` when a run
 * serves any. Null without `options.hosts`.
 */
export function namedHostsRuntime(
	hosts: boolean | HostsOptionsLike | undefined,
	plan: NamedHost[],
	live: NamedHostsActivation | undefined,
): HostsRuntime | null {
	if (!hosts) return null;
	return {
		plan,
		active: live !== undefined,
		tld: typeof hosts === "object" ? (hosts.tld ?? "localhost") : "localhost",
		mode: hostsMode() === "tailscale" ? "tailscale" : "loopback",
		caPath: live?.caPath,
		tailscaleUrls: live?.tailscaleUrls ?? {},
	};
}

/**
 * `plainUrls` with the named URLs `hosts` has active: Tailscale's per app,
 * or the loopback plan's entries, only `served` ones when given.
 */
export function namedUrls(
	plainUrls: UrlMap,
	hosts: HostsRuntime | null,
	served: ReadonlySet<string> | undefined,
): UrlMap {
	const urls = { ...plainUrls };
	if (!hosts?.active) return urls;
	if (hosts.mode === "tailscale") return { ...urls, ...hosts.tailscaleUrls };
	const plan = served
		? hosts.plan.filter((entry) => served.has(entry.hostname))
		: hosts.plan;
	applyHostPlanToUrls(urls, plan);
	return urls;
}

/** What one computed environment is built from: a view, or a run's context over one. */
export interface SharedEnvSource<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
> {
	readonly config: { env?: (...args: never[]) => EnvValues };
	readonly projectName: string;
	readonly workspaceId: string;
	readonly localIp: string;
	readonly portOffset: number;
	readonly services: TServices;
	readonly apps: TApps;
	readonly ports: ComputedPorts<TServices, TApps>;
	readonly urls: ComputedUrls<TServices, TApps>;
	readonly loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	readonly inputEnv: EnvInput;
	readonly envOverrides: Readonly<Record<string, string>>;
}

/** The live state a computed environment adds to its source. */
export interface SharedEnvExtras {
	production?: boolean;
	publicUrls: Readonly<Record<string, string>>;
	captured: Readonly<Record<string, string>>;
	hosts: HostsRuntime | null;
}

/** The context `env` and `envVars` callbacks receive. */
export function envOverlayContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	source: SharedEnvSource<TServices, TApps>,
	extras: SharedEnvExtras,
): EnvVarsContext<TServices, TApps> {
	return {
		env: source.inputEnv.merged,
		projectName: source.projectName,
		workspaceId: source.workspaceId,
		localIp: source.localIp,
		portOffset: source.portOffset,
		publicUrls: extras.publicUrls as ComputedPublicUrls<TServices, TApps>,
		loopbackUrls: source.loopbackUrls,
		captured: extras.captured,
	};
}

/**
 * The hosts Vite must accept for named URLs: every `.<tld>` name behind the
 * loopback daemon, or the machine names Tailscale serves apps under.
 */
function namedAllowedHosts(hosts: HostsRuntime | null): string[] {
	if (!hosts?.active) return [];
	if (hosts.mode === "loopback") return [`.${hosts.tld}`];
	const names = Object.values(hosts.tailscaleUrls).map(
		(url) => new URL(url).hostname,
	);
	return [...new Set(names)];
}

/**
 * The environment every process of a run shares, and what `getEnvVar`
 * answers from: computed names, captures, the declared input beneath them,
 * the config's `env` overlay above, and `buncargo env set` last.
 */
export function sharedEnv<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	source: SharedEnvSource<TServices, TApps>,
	extras: SharedEnvExtras,
): EnvValues {
	const { services, apps, ports, urls, loopbackUrls } = source;
	const { hosts } = extras;
	const shared = buildSharedEnvValues({
		projectName: source.projectName,
		production: extras.production,
		services,
		ports,
		urls,
		loopbackUrls,
		publicUrls: extras.publicUrls,
	});
	Object.assign(shared, capturedEnv(apps, extras.captured));
	shared.BUNCARGO_WORKSPACE_ID = source.workspaceId;
	if (hosts?.active && hosts.caPath) shared.NODE_EXTRA_CA_CERTS = hosts.caPath;
	// Vite answers 403 to a Host it does not know. Comma-separated: the
	// buncargo Vite plugin splits the list.
	const allowedHosts = [
		...new Set([...namedAllowedHosts(hosts), urlHostOverride()]),
	].filter(isDefined);
	if (allowedHosts.length > 0)
		shared.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = allowedHosts.join(",");

	const merged = mergeSharedEnvWithOverlay(
		{ ...source.inputEnv.declared, ...shared },
		source.config.env as EnvVarsBuilder<TServices, TApps> | undefined,
		ports,
		urls,
		envOverlayContext(source, extras),
	);
	applyEnvOverrides(
		merged as Record<string, string>,
		source.envOverrides,
		source.inputEnv.declared,
	);
	return merged;
}
