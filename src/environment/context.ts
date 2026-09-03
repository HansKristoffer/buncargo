import type { ContainerRuntimeAdapter } from "../container-runtime";
import {
	resolveContainerRuntime,
	resolveContainerRuntimeBinary,
} from "../container-runtime";
import { applyHostPlanToUrls, planNamedHosts } from "../core/hosts/plan";
import { getLocalIp } from "../core/network";
import { resolvePortPlan } from "../core/port-allocation";
import {
	asComputedLoopbackUrls,
	asComputedPorts,
	asComputedUrls,
	computeDevIdentity,
	computeLoopbackUrls,
	computeUrls,
	findMonorepoRoot,
	toUrlMap,
	type UrlMap,
} from "../core/ports";
import type { PublicTunnel } from "../core/tunnel";
import {
	buildComposeModel,
	type ComposeDocument,
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "../docker-compose";
import type {
	AppConfig,
	ComputedLoopbackUrls,
	ComputedPorts,
	ComputedUrls,
	DevConfig,
	DevEnvironmentTunnelLog,
	EnvValues,
	HostsOptionsLike,
	HostsRuntime,
	PortOffsetProvenance,
	ServiceConfig,
} from "../types";
import { logEnvironmentInfo } from "./logging";

/**
 * Everything a dev environment derives from its config once, up front: identity,
 * ports, URLs and the mutable url/public-url state the CLI flips at runtime.
 *
 * The sibling modules (`env-vars`, `lifecycle`, `servers`, `watchdog`) take this
 * as their only shared state, so `createDevEnvironment` stays a composer.
 */
export interface DevEnvContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
> {
	readonly config: DevConfig<TServices, TApps, TEnv>;
	readonly root: string;
	readonly projectName: string;
	readonly projectSuffix: string | undefined;
	readonly worktree: boolean;
	readonly localIp: string;
	readonly services: TServices;
	readonly apps: TApps;
	readonly ports: ComputedPorts<TServices, TApps>;
	readonly urls: ComputedUrls<TServices, TApps>;
	/**
	 * The `http://localhost:<port>` form, immune to the named-host rewrite that
	 * `setNamedHostsActive` applies to `urls` in place.
	 */
	readonly loopbackUrls: ComputedLoopbackUrls<TServices, TApps>;
	/** Mutated in place so consumers holding the object see tunnel updates. */
	readonly publicUrls: UrlMap;
	readonly portOffset: number;
	readonly portOffsetProvenance: PortOffsetProvenance;
	readonly composeFile: string;
	/** The backend that runs the services, resolved once from flag/env/config. */
	readonly runtime: ContainerRuntimeAdapter;
	/** The binary it was resolved to, for callers that rebuild the adapter. */
	readonly runtimeBinary: string | undefined;
	readonly hosts: HostsRuntime | null;
	ensureComposeFile(): string;
	/**
	 * The same service model the compose file is rendered from.
	 *
	 * Backends that have no compose equivalent walk this instead of the file,
	 * so both views of a stack come from one build.
	 */
	composeModel(): ComposeDocument;
	setNamedHostsActive(active: boolean, extras?: { caPath?: string }): void;
	/** Absent entries are skipped: only exposed targets that came up have a URL. */
	setPublicUrls(urls: Readonly<Record<string, string | undefined>>): void;
	clearPublicUrls(): void;
	logInfo(label?: string, tunnels?: PublicTunnel[]): void;
}

function resolveHostsTld(hosts: boolean | HostsOptionsLike): string {
	return typeof hosts === "object" ? (hosts.tld ?? "localhost") : "localhost";
}

export function createDevEnvContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
	TEnv extends EnvValues = EnvValues,
>(
	config: DevConfig<TServices, TApps, TEnv>,
	options: { suffix?: string; containerRuntime?: string } = {},
): DevEnvContext<TServices, TApps, TEnv> {
	const root = findMonorepoRoot();
	const suffix = options.suffix;
	const { worktree, worktreeSuffix, projectSuffix, projectName } =
		computeDevIdentity({
			projectPrefix: config.projectPrefix,
			suffix,
			root,
			worktreeIsolation: config.options?.worktreeIsolation,
		});
	const localIp = getLocalIp();

	const services = config.services;
	const apps = (config.apps ?? {}) as TApps;
	const composeFile = getGeneratedComposePath(
		root,
		config.docker,
	).composeFileArg;
	const runtimeSelection = {
		flag: options.containerRuntime,
		docker: config.docker,
	};
	const runtime = resolveContainerRuntime(runtimeSelection);
	const runtimeBinary = resolveContainerRuntimeBinary(runtimeSelection);

	const portPlan = resolvePortPlan({
		projectPrefix: config.projectPrefix,
		projectName,
		root,
		services,
		apps,
		suffix,
		worktreeName: worktreeSuffix,
		worktreeIsolation: config.options?.worktreeIsolation,
		// Without the resolved backend the allocator asks Docker about every
		// port, so this project's own Apple containers look foreign and shift
		// the offset on every run.
		runtime,
	});
	const portMap = portPlan.ports;
	const ports = asComputedPorts<TServices, TApps>(portMap);

	const hostsPlan = config.options?.hosts
		? planNamedHosts({
				projectPrefix: config.projectPrefix,
				worktreeSuffix,
				apps,
				services,
				ports: portMap,
				hosts: config.options.hosts,
				primaryApp: config.options.primaryApp,
			})
		: [];
	const hosts: HostsRuntime | null = config.options?.hosts
		? {
				plan: hostsPlan,
				active: false,
				tld: resolveHostsTld(config.options.hosts),
			}
		: null;

	const plainUrls: UrlMap = computeUrls(services, apps, portMap, localIp);
	const urls = asComputedUrls<TServices, TApps>({ ...plainUrls });
	const loopbackUrls = asComputedLoopbackUrls<TServices, TApps>(
		computeLoopbackUrls(services, apps, portMap),
	);
	const publicUrls: UrlMap = {};

	return {
		config,
		root,
		projectName,
		projectSuffix,
		worktree,
		localIp,
		services,
		apps,
		ports,
		urls,
		loopbackUrls,
		publicUrls,
		portOffset: portPlan.offset,
		portOffsetProvenance: portPlan.provenance,
		composeFile,
		runtime,
		runtimeBinary,
		hosts,

		ensureComposeFile() {
			return writeGeneratedComposeFile(
				root,
				services,
				config.docker,
				{ projectName, root, worktree: worktreeSuffix },
				runtime.name,
			);
		},

		composeModel() {
			return buildComposeModel(
				services,
				config.docker,
				{ projectName, root, worktree: worktreeSuffix },
				runtime.name,
			);
		},

		setNamedHostsActive(active, extras = {}) {
			if (!hosts) return;
			hosts.active = active;
			hosts.caPath = extras.caPath;
			const urlMap = toUrlMap(urls);
			for (const [key, value] of Object.entries(plainUrls)) {
				urlMap[key] = value;
			}
			if (active && hosts.plan.length > 0) {
				applyHostPlanToUrls(urlMap, hosts.plan);
			}
		},

		setPublicUrls(next) {
			for (const key of Object.keys(publicUrls)) {
				delete publicUrls[key];
			}
			for (const [key, value] of Object.entries(next)) {
				if (value !== undefined) publicUrls[key] = value;
			}
		},

		clearPublicUrls() {
			for (const key of Object.keys(publicUrls)) {
				delete publicUrls[key];
			}
		},

		logInfo(label = "Dev Environment", tunnels?: PublicTunnel[]) {
			const tunnelRows: DevEnvironmentTunnelLog[] | undefined = tunnels?.map(
				({ kind, name, localUrl, publicUrl }) => ({
					kind,
					name,
					localUrl,
					publicUrl,
				}),
			);
			logEnvironmentInfo({
				label,
				projectPrefix: config.projectPrefix,
				projectName,
				worktreeSuffix,
				services,
				apps,
				ports: portMap,
				urls: toUrlMap(urls),
				localIp,
				portOffset: portPlan.offset,
				tunnels: tunnelRows,
			});
		},
	};
}
