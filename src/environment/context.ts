import { applyHostPlanToUrls, planNamedHosts } from "../core/hosts/plan";
import { getLocalIp } from "../core/network";
import { resolvePortPlan } from "../core/port-allocation";
import {
	computeDevIdentity,
	computeUrls,
	findMonorepoRoot,
} from "../core/ports";
import type { PublicTunnel } from "../core/tunnel";
import {
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "../docker-compose";
import type {
	AppConfig,
	ComputedPorts,
	ComputedUrls,
	DevConfig,
	DevEnvironmentTunnelLog,
	HostsOptions,
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
> {
	readonly config: DevConfig<TServices, TApps>;
	readonly root: string;
	readonly projectName: string;
	readonly projectSuffix: string | undefined;
	readonly worktree: boolean;
	readonly localIp: string;
	readonly services: TServices;
	readonly apps: TApps;
	readonly ports: ComputedPorts<TServices, TApps>;
	readonly urls: ComputedUrls<TServices, TApps>;
	/** Mutated in place so consumers holding the object see tunnel updates. */
	readonly publicUrls: Record<string, string>;
	readonly portOffset: number;
	readonly portOffsetProvenance: PortOffsetProvenance;
	readonly composeFile: string;
	readonly hosts: HostsRuntime | null;
	ensureComposeFile(): string;
	setNamedHostsActive(active: boolean, extras?: { caPath?: string }): void;
	setPublicUrls(urls: Record<string, string>): void;
	clearPublicUrls(): void;
	logInfo(label?: string, tunnels?: PublicTunnel[]): void;
}

function resolveHostsTld(hosts: boolean | HostsOptions): string {
	return typeof hosts === "object" ? (hosts.tld ?? "localhost") : "localhost";
}

export function createDevEnvContext<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	config: DevConfig<TServices, TApps>,
	options: { suffix?: string } = {},
): DevEnvContext<TServices, TApps> {
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
	const ports = portPlan.ports as ComputedPorts<TServices, TApps>;

	const hostsPlan = config.options?.hosts
		? planNamedHosts({
				projectPrefix: config.projectPrefix,
				worktreeSuffix,
				apps,
				services,
				ports: ports as Record<string, number>,
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

	const plainUrls = computeUrls(services, apps, ports, localIp) as ComputedUrls<
		TServices,
		TApps
	>;
	const urls = { ...plainUrls } as ComputedUrls<TServices, TApps>;
	const publicUrls: Record<string, string> = {};

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
			for (const [key, value] of Object.entries(plainUrls)) {
				(urls as Record<string, string>)[key] = value;
			}
			if (active && hosts.plan.length > 0) {
				applyHostPlanToUrls(urls as Record<string, string>, hosts.plan);
			}
		},

		setPublicUrls(next) {
			for (const key of Object.keys(publicUrls)) {
				delete publicUrls[key];
			}
			for (const [key, value] of Object.entries(next)) {
				publicUrls[key] = value;
			}
		},

		clearPublicUrls() {
			for (const key of Object.keys(publicUrls)) {
				delete publicUrls[key];
			}
		},

		logInfo(label = "Docker Dev", tunnels?: PublicTunnel[]) {
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
				projectName,
				services,
				apps,
				ports: ports as Record<string, number>,
				urls: urls as Record<string, string>,
				localIp,
				worktree,
				portOffset: portPlan.offset,
				projectSuffix,
				tunnels: tunnelRows,
			});
		},
	};
}
