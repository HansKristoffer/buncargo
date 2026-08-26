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
	readonly hosts: HostsRuntime | null;
	ensureComposeFile(): string;
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
	options: { suffix?: string } = {},
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

	const portPlan = resolvePortPlan({
		projectPrefix: config.projectPrefix,
		projectName,
		root,
		services,
		apps,
		suffix,
		worktreeName: worktreeSuffix,
		worktreeIsolation: config.options?.worktreeIsolation,
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
		hosts,

		ensureComposeFile() {
			return writeGeneratedComposeFile(root, services, config.docker, {
				projectName,
				root,
				worktree: worktreeSuffix,
			});
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
