import type { ContainerRuntimeAdapter } from "../container-runtime";
import {
	assertServiceCapabilities,
	resolveContainerRuntime,
	resolveContainerRuntimeBinary,
} from "../container-runtime";
import { loadEnvInput } from "../core/env-input";
import { applyHostPlanToUrls, planNamedHosts } from "../core/hosts/plan";
import { getLocalIp } from "../core/network";
import {
	candidateAllocationPorts,
	resolvePortPlan,
} from "../core/port-allocation";
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
import {
	createPortOwnerSnapshot,
	createPortOwnerSnapshotAsync,
	type PortOwnerSnapshot,
	withBindProbe,
} from "../core/process";
import { portOffsetOverride } from "../core/runtime-flags";
import { applySecretDefaults } from "../core/secrets/infisical";
import type { PublicTunnel } from "../core/tunnel";
import { workspaceId } from "../core/workspace-identity";
import {
	buildComposeModel,
	type ComposeDocument,
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "../docker-compose";
import { planStart, type StartPlan } from "../planning";
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
import type { EnvironmentLogSelection } from "../types/environment";
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
	getStartPlan(
		onlyApps?: string[],
		onlyServices?: readonly string[],
	): StartPlan;
	prepareStart(onlyApps?: string[], onlyServices?: readonly string[]): void;
	prepareStartAsync(
		onlyApps?: string[],
		onlyServices?: readonly string[],
		signal?: AbortSignal,
	): Promise<void>;
	readonly hasSelectedServices: boolean;
	/** Service keys the current selection starts, for the run claim. */
	readonly selectedServiceKeys: readonly string[];
	readonly ownedServerPids: Record<string, number>;
	/** Values apps printed (`captures`), shared by hooks, env and generated files. */
	readonly captured: Record<string, string>;
	readonly inputEnv: Readonly<Record<string, string>>;
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
	readonly workspaceId: string;
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
	onSecretsWait?: (ms: number) => void;
	logInfo(
		label?: string,
		tunnels?: PublicTunnel[],
		selection?: EnvironmentLogSelection,
	): void;
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
	options: {
		suffix?: string;
		containerRuntime?: string;
		root?: string;
		readOnly?: boolean;
	} = {},
): DevEnvContext<TServices, TApps, TEnv> {
	const root = options.root ?? findMonorepoRoot();
	const inputEnv = loadEnvInput(root, config.options?.envFiles);
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
	// Resolved once, here, because this is the last place the config-level
	// defaults and the apps are both in hand: every spawner downstream reads the
	// scope off `app.secrets` alone.
	const apps = applySecretDefaults(
		(config.apps ?? {}) as TApps,
		config.secrets,
	);
	// A suffixed environment (`withSuffix`, `buncargo ci`) is a second stack in
	// the same checkout: it gets its own compose file and never persists its
	// ports, or it would overwrite the ones the checkout's own `dev` run and
	// every `exec`/`env` read.
	const docker =
		suffix && !config.docker?.generatedFile
			? {
					...config.docker,
					generatedFile: `.buncargo/docker-compose.${suffix.replace(/[^A-Za-z0-9-]/g, "-")}.generated.yml`,
				}
			: config.docker;
	const composeFile = getGeneratedComposePath(root, docker).composeFileArg;
	const runtimeSelection = {
		flag: options.containerRuntime,
		docker: config.docker,
	};
	let resolvedRuntime: ContainerRuntimeAdapter | undefined;
	const runtime = () => {
		resolvedRuntime ??= resolveContainerRuntime(runtimeSelection);
		return resolvedRuntime;
	};
	let hasSelectedServices = false;
	let selectedServiceKeys: readonly string[] = [];
	let preparedSelection: string | undefined;

	let portPlan = resolvePortPlan({
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
		persist: false,
		probeConflicts: false,
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

	function refreshUrls() {
		const urlMap = toUrlMap(urls);
		Object.assign(urlMap, plainUrls);

		if (hosts?.active) {
			applyHostPlanToUrls(urlMap, hosts.plan);
		}
	}

	let model: ComposeDocument | undefined;
	const buildModel = () =>
		buildComposeModel(
			services,
			config.docker,
			{ projectName, root, worktree: worktreeSuffix },
			runtime().name,
		);

	let cachedPlan: { selection: string; plan: StartPlan } | undefined;
	function getStartPlan(
		onlyApps?: string[],
		onlyServices?: readonly string[],
	): StartPlan {
		const selection = JSON.stringify([onlyApps ?? null, onlyServices ?? null]);
		if (cachedPlan?.selection !== selection)
			cachedPlan = {
				selection,
				plan: planStart(apps, services, { onlyApps, onlyServices }),
			};
		return cachedPlan.plan;
	}

	function prepareStart(
		onlyApps?: string[],
		onlyServices?: readonly string[],
		suppliedSnapshot?: PortOwnerSnapshot,
	) {
		const plan = getStartPlan(onlyApps, onlyServices);
		const selection = JSON.stringify([plan.appNames, plan.requiredServiceKeys]);

		// The CLI prepares before touching hosts; lifecycle.start reaches this
		// again. Reuse that allocation rather than probing the same run twice.
		if (selection === preparedSelection) {
			return;
		}
		hasSelectedServices = plan.requiredServiceKeys.length > 0;
		selectedServiceKeys = plan.requiredServiceKeys;
		const selectedRuntime = hasSelectedServices ? runtime() : undefined;

		if (selectedRuntime) {
			const selectedServices = Object.fromEntries(
				plan.requiredServiceKeys.map((name) => [name, services[name]]),
			);
			assertServiceCapabilities(selectedRuntime.name, selectedServices);
		}

		// App-only selection still checks host processes, without asking any runtime.
		const snapshot =
			suppliedSnapshot ??
			(hasSelectedServices
				? undefined
				: createPortOwnerSnapshot({ containers: new Map() }));
		portPlan = resolvePortPlan({
			projectPrefix: config.projectPrefix,
			projectName,
			root,
			services,
			apps,
			suffix,
			worktreeName: worktreeSuffix,
			worktreeIsolation: config.options?.worktreeIsolation,
			runtime: selectedRuntime,
			persist: suffix === undefined,
			// The bind probe here too: this is the allocation every dev run
			// makes, and a snapshot only knows what `lsof` lets this user see.
			getOwner: snapshot
				? withBindProbe((port) => snapshot.owner(port))
				: undefined,
			probeNames: hasSelectedServices ? undefined : plan.appNames,
		});

		// Keep object identity: env callbacks may already hold these maps.
		Object.assign(portMap, portPlan.ports);
		Object.assign(plainUrls, computeUrls(services, apps, portMap, localIp));
		Object.assign(loopbackUrls, computeLoopbackUrls(services, apps, portMap));
		for (const host of hostsPlan) {
			host.targetPort = portMap[host.name] ?? host.targetPort;
		}
		refreshUrls();
		preparedSelection = selection;
	}

	return {
		ownedServerPids: {},
		captured: {},
		inputEnv,
		get hasSelectedServices() {
			return hasSelectedServices;
		},
		get selectedServiceKeys() {
			return selectedServiceKeys;
		},
		getStartPlan,
		prepareStart,
		async prepareStartAsync(onlyApps, onlyServices, signal) {
			signal?.throwIfAborted();
			const plan = getStartPlan(onlyApps, onlyServices);
			const selection = JSON.stringify([
				plan.appNames,
				plan.requiredServiceKeys,
			]);
			if (selection === preparedSelection) return;
			const selectedRuntime =
				plan.requiredServiceKeys.length > 0 ? runtime() : undefined;
			if (selectedRuntime)
				assertServiceCapabilities(
					selectedRuntime.name,
					Object.fromEntries(
						plan.requiredServiceKeys.map((name) => [name, services[name]]),
					),
				);
			const candidatePorts = candidateAllocationPorts(
				{
					projectPrefix: config.projectPrefix,
					worktreeName: worktreeSuffix,
					suffix,
					worktreeIsolation: config.options?.worktreeIsolation,
					services,
					apps,
					probeNames: selectedRuntime ? undefined : plan.appNames,
				},
				portPlan.offset,
			);
			const snapshot =
				portOffsetOverride() === undefined
					? await createPortOwnerSnapshotAsync({
							runtime: selectedRuntime,
							ports: candidatePorts,
							skipContainers: !selectedRuntime,
							signal,
						})
					: { owner: () => null, isBusy: () => false };
			signal?.throwIfAborted();
			prepareStart(onlyApps, onlyServices, snapshot);
		},
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
		workspaceId: workspaceId(root),
		get portOffset() {
			return portPlan.offset;
		},
		get portOffsetProvenance() {
			return portPlan.provenance;
		},
		composeFile,
		get runtime() {
			return runtime();
		},
		get runtimeBinary() {
			return resolveContainerRuntimeBinary(runtimeSelection);
		},
		hosts,

		ensureComposeFile() {
			model = buildModel();
			return writeGeneratedComposeFile(
				root,
				services,
				docker,
				{ projectName, root, worktree: worktreeSuffix },
				runtime().name,
				model,
			);
		},

		composeModel() {
			model ??= buildModel();
			return model;
		},

		setNamedHostsActive(active, extras = {}) {
			if (!hosts) {
				return;
			}
			hosts.active = active;
			hosts.caPath = extras.caPath;
			refreshUrls();
		},

		setPublicUrls(next) {
			for (const key of Object.keys(publicUrls)) {
				delete publicUrls[key];
			}

			for (const [key, value] of Object.entries(next)) {
				if (value !== undefined) {
					publicUrls[key] = value;
				}
			}
		},

		clearPublicUrls() {
			for (const key of Object.keys(publicUrls)) {
				delete publicUrls[key];
			}
		},

		logInfo(
			label = "Dev Environment",
			tunnels?: PublicTunnel[],
			selection?: EnvironmentLogSelection,
		) {
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
				services: selection
					? Object.fromEntries(
							Object.entries(services).filter(([name]) =>
								selection.requiredServiceKeys.includes(name),
							),
						)
					: services,
				apps: selection
					? Object.fromEntries(
							Object.entries(apps).filter(([name]) =>
								selection.appNames.includes(name),
							),
						)
					: apps,
				ports: portMap,
				urls: toUrlMap(urls),
				localIp,
				portOffset: portPlan.offset,
				tunnels: tunnelRows,
				hintFor: (name) => {
					const app = apps[name];
					if (!app) return undefined;
					for (const integration of config.integrations ?? []) {
						const hint = integration.bannerHint?.({
							name,
							config: app,
							port: portMap[name],
							root,
							workspaceId: workspaceId(root),
						});
						if (hint) return hint;
					}
					return undefined;
				},
			});
		},
	};
}
