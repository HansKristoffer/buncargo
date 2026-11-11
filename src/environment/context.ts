import { extname } from "node:path";
import { pick } from "hanzio";
import type { ContainerRuntimeAdapter } from "../container-runtime";
import {
	assertServiceCapabilities,
	resolveContainerRuntime,
	resolveContainerRuntimeBinary,
} from "../container-runtime";
import {
	namedHostsRuntime,
	namedUrls,
	resolveCheckoutView,
} from "../core/checkout-view";
import type { EnvInput } from "../core/env-input";
import { tailscaleBlockPorts } from "../core/hosts/tailscale-serve";
import {
	markOffsetClaimsReclaimed,
	offsetClaimKey,
	readAllOffsetClaims,
} from "../core/offset-claims";
import {
	allocatePortBlock,
	candidateAllocationPorts,
} from "../core/port-allocation";
import {
	computeLoopbackUrls,
	computeUrls,
	findMonorepoRoot,
	type PortMap,
	type UrlMap,
} from "../core/ports";
import {
	createPortOwnerSnapshot,
	createPortOwnerSnapshotAsync,
	type PortOwnerSnapshot,
	withBindProbe,
} from "../core/process";
import { readAllRuns } from "../core/run-registry";
import {
	hostsMode,
	isCI,
	portOffsetOverride,
	urlHostOverride,
} from "../core/runtime-flags";
import type { PublicTunnel } from "../core/tunnel";
import { workspaceId } from "../core/workspace-identity";
import {
	type AssignedPortTarget,
	assignedPortTargets,
	buildComposeModel,
	type ComposeDocument,
	getGeneratedComposePath,
	writeGeneratedComposeFile,
} from "../docker-compose";
import { planStart, type StartPlan } from "../planning";
import type {
	AppConfig,
	DevEnvironmentTunnelLog,
	HostsRuntime,
	NamedHostsActivation,
	PortOffsetProvenance,
	ResolvedApp,
	ResolvedDevConfig,
	ResolvedService,
	ServiceConfig,
} from "../types";
import type {
	EnvironmentLogSelection,
	SuffixedEnvironmentOptions,
} from "../types/environment";
import { logEnvironmentInfo } from "./logging";
import { allocateReclaiming } from "./port-reclaim";
import { type StatusOutput, TERMINAL_OUTPUT } from "./status-output";

/**
 * A config's services and apps with their keys unknown. The modules here read
 * the config this way; `createDevEnvironment` applies the typed view once.
 */
export type AnyServices = Record<string, ServiceConfig>;
export type AnyApps = Record<string, AppConfig>;

/** The apps and services a run selected, `requiredApps` and dependencies expanded. */
export interface StartSelection {
	readonly appNames: readonly string[];
	readonly requiredServiceKeys: readonly string[];
}

/**
 * Everything a dev environment derives from its config once, up front: identity,
 * ports, URLs and the mutable url/public-url state the CLI flips at runtime.
 *
 * The sibling modules (`env-vars`, `lifecycle`, `servers`, `watchdog`) take this
 * as their only shared state, so `createDevEnvironment` stays a composer.
 */
export interface DevEnvContext {
	getStartPlan(
		onlyApps?: string[],
		onlyServices?: readonly string[],
	): StartPlan;
	prepareStart(onlyApps?: string[], onlyServices?: readonly string[]): void;
	/** The full selection's allocation as a run would make it, claiming and writing nothing. */
	planPortOffset(): { offset: number; provenance: PortOffsetProvenance };
	prepareStartAsync(
		onlyApps?: string[],
		onlyServices?: readonly string[],
		signal?: AbortSignal,
	): Promise<void>;
	/**
	 * Read this environment's offset claim before its teardown, if it is
	 * throwaway: suffixed, or running in CI. A developer's dev checkout keeps
	 * its block while stopped. The returned function drops the claim after
	 * the teardown, unless another run of this environment used the block
	 * since it was read.
	 */
	captureThrowawayClaim(): () => Promise<void>;
	readonly hasSelectedServices: boolean;
	/** Service keys the current selection starts, for the run claim. */
	readonly selectedServiceKeys: readonly string[];
	/**
	 * The expanded selection `prepareStart` last allocated for, which hooks
	 * are told about; undefined before any preparation.
	 */
	readonly selection: StartSelection | undefined;
	readonly ownedServerPids: Record<string, number>;
	/** Values apps printed (`captures`), shared by hooks, env and generated files. */
	readonly captured: Record<string, string>;
	readonly inputEnv: EnvInput;
	/** `buncargo env set` values, applied on top of every computed environment. */
	readonly envOverrides: Readonly<Record<string, string>>;
	readonly config: ResolvedDevConfig;
	readonly root: string;
	readonly projectName: string;
	readonly projectSuffix: string | undefined;
	readonly worktree: boolean;
	readonly localIp: string;
	readonly services: Record<string, ResolvedService>;
	readonly apps: Record<string, ResolvedApp>;
	readonly ports: PortMap;
	readonly urls: UrlMap;
	/**
	 * The `http://localhost:<port>` form, immune to the named-host rewrite that
	 * `setNamedHostsActive` applies to `urls` in place.
	 */
	readonly loopbackUrls: UrlMap;
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
	/**
	 * The selected services' port keys that publish on runtime-assigned host
	 * ports (`withSuffix(…, { ports: "assigned" })` on a runtime that can),
	 * for `ensureServicesRunning` to read back.
	 */
	assignedPortTargets(
		serviceKeys: readonly string[],
	): Record<string, AssignedPortTarget>;
	/**
	 * Take the host ports read back after `up` into `ports`, `urls` and every
	 * environment built from them, and keep them over later allocations.
	 */
	adoptAssignedPorts(hostPorts: Readonly<Record<string, number>>): void;
	ensureComposeFile(): string;
	/**
	 * The same service model the compose file is rendered from.
	 *
	 * Backends that have no compose equivalent walk this instead of the file,
	 * so both views of a stack come from one build.
	 */
	composeModel(): ComposeDocument;
	setNamedHostsActive(active: boolean, extras?: NamedHostsActivation): void;
	/** Absent entries are skipped: only exposed targets that came up have a URL. */
	setPublicUrls(urls: Readonly<Record<string, string | undefined>>): void;
	clearPublicUrls(): void;
	onSecretsWait?: (ms: number) => void;
	/** Where the lifecycle reports its progress; see {@link StatusOutput}. */
	output: StatusOutput;
	logInfo(
		label?: string,
		tunnels?: PublicTunnel[],
		selection?: EnvironmentLogSelection,
	): void;
}

/**
 * A suffixed environment's compose file beside the configured one: the
 * suffix before the extension. Sharing the file let `ci` overwrite the dev
 * stack's model, and fail where it is written only when missing.
 */
function suffixedComposeFile(
	generatedFile: string | undefined,
	suffix: string,
): string {
	const label = suffix.replace(/[^A-Za-z0-9-]/g, "-");
	if (generatedFile === undefined)
		return `.buncargo/docker-compose.${label}.generated.yml`;
	const extension = extname(generatedFile);
	const stem = generatedFile.slice(0, generatedFile.length - extension.length);
	return `${stem}.${label}${extension}`;
}

export function createDevEnvContext(
	config: ResolvedDevConfig,
	options: {
		suffix?: string;
		containerRuntime?: string;
		root?: string;
	} & SuffixedEnvironmentOptions = {},
): DevEnvContext {
	const root = options.root ?? findMonorepoRoot();
	const suffix = options.suffix;
	// The checkout view `getEnvVar` answers from, made this environment's own:
	// its maps are new objects, which allocation updates in place.
	const view = resolveCheckoutView(config, root, { suffix });
	const { worktree, worktreeSuffix, projectSuffix, projectName, localIp } =
		view;
	const { inputEnv, envOverrides, services, apps } = view;
	// A suffixed environment (`withSuffix`, `buncargo ci`) is a second stack in
	// the same checkout: it gets its own compose file and never persists its
	// ports, or it would overwrite the ones the checkout's own `dev` run and
	// every `exec`/`env` read.
	const docker = suffix
		? {
				...config.docker,
				generatedFile: suffixedComposeFile(
					config.docker?.generatedFile,
					suffix,
				),
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
	let startSelection: StartSelection | undefined;
	let preparedSelection: string | undefined;

	/**
	 * A suffixed environment, or any in CI, gives its port block back when it
	 * ends; a developer's dev checkout keeps its block while stopped.
	 */
	const throwaway = () => suffix !== undefined || isCI();
	let portPlan = view.portPlan;
	const portMap = portPlan.ports;
	const { ports, plainUrls, loopbackUrls } = view;
	const hostsPlan = view.hostPlan;
	const hosts = namedHostsRuntime(config.options?.hosts, hostsPlan, undefined);
	const urls: UrlMap = { ...plainUrls };
	const publicUrls: UrlMap = {};
	// Loopback: the plan's hostnames being served, when only some are.
	let servedHostnames: ReadonlySet<string> | undefined;

	function refreshUrls() {
		Object.assign(urls, namedUrls(plainUrls, hosts, servedHostnames));
	}

	// Host ports the runtime picked, which outlive a later allocation.
	const assignedHostPorts: Record<string, number> = {};
	let model: ComposeDocument | undefined;
	const buildModel = () =>
		buildComposeModel(
			services,
			config.docker,
			{ projectName, root, worktree: worktreeSuffix },
			runtime().name,
			{
				data: options.data,
				// A runtime that cannot pick one keeps the claimed block.
				ports:
					options.ports === "assigned" &&
					runtime().capabilities.assignedHostPorts
						? "assigned"
						: "claimed",
			},
		);

	function composeModel(): ComposeDocument {
		model ??= buildModel();
		return model;
	}

	/** Point the URLs, and the named hosts' targets, at `portMap`. */
	function refreshPorts() {
		Object.assign(
			plainUrls,
			computeUrls(services, apps, portMap, localIp, urlHostOverride()),
		);
		Object.assign(loopbackUrls, computeLoopbackUrls(services, apps, portMap));
		for (const host of hostsPlan) {
			host.targetPort = portMap[host.name] ?? host.targetPort;
		}
		refreshUrls();
	}

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

	/** What every allocation of a plan passes; callers add what it writes and how it probes. */
	function allocationInput(
		plan: StartPlan,
		selectedRuntime: ContainerRuntimeAdapter | undefined,
	) {
		return {
			projectPrefix: config.projectPrefix,
			projectName,
			root,
			services,
			apps,
			suffix,
			worktreeName: worktreeSuffix,
			worktreeIsolation: config.options?.worktreeIsolation,
			runtime: selectedRuntime,
			probeNames: selectedRuntime ? undefined : plan.appNames,
			companionPorts: tailscaleBlockPorts({
				mode: hostsMode(),
				hosts: Boolean(config.options?.hosts),
				appNames: Object.keys(apps),
			}),
		};
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
		const withServices = plan.requiredServiceKeys.length > 0;
		const selectedRuntime = withServices ? runtime() : undefined;

		if (selectedRuntime) {
			const selectedServices = pick(services, plan.requiredServiceKeys);
			assertServiceCapabilities(selectedRuntime, selectedServices);
		}

		// App-only selection still checks host processes, without asking any runtime.
		const snapshot =
			suppliedSnapshot ??
			(withServices
				? undefined
				: createPortOwnerSnapshot({ containers: new Map() }));
		portPlan = allocatePortBlock({
			...allocationInput(plan, selectedRuntime),
			// Every environment claims its offset, so parallel suffixed runs
			// (CI jobs on one machine) never share one.
			claim: true,
			throwaway: throwaway(),
			// The bind probe here too: this is the allocation every dev run
			// makes, and a snapshot only knows what `lsof` lets this user see.
			getOwner: snapshot
				? withBindProbe((port) => snapshot.owner(port))
				: undefined,
		});

		// Keep object identity: env callbacks may already hold these maps.
		Object.assign(portMap, portPlan.ports, assignedHostPorts);
		refreshPorts();
		// Published only with its block: an allocation that threw (the range
		// is full) selected nothing that a caller could read as allocated.
		hasSelectedServices = withServices;
		selectedServiceKeys = plan.requiredServiceKeys;
		startSelection = {
			appNames: plan.appNames,
			requiredServiceKeys: plan.requiredServiceKeys,
		};
		preparedSelection = selection;
	}

	return {
		ownedServerPids: {},
		captured: {},
		inputEnv,
		envOverrides,
		get hasSelectedServices() {
			return hasSelectedServices;
		},
		get selectedServiceKeys() {
			return selectedServiceKeys;
		},
		get selection() {
			return startSelection;
		},
		getStartPlan,
		prepareStart,
		planPortOffset() {
			const plan = getStartPlan();
			const selectedRuntime =
				plan.requiredServiceKeys.length > 0 ? runtime() : undefined;
			// Its own probe, bind-probed like a run's when no owner is given.
			const { offset, provenance } = allocatePortBlock({
				...allocationInput(plan, selectedRuntime),
				claim: false,
			});
			return { offset, provenance };
		},
		captureThrowawayClaim() {
			if (!throwaway()) return async () => {};
			const key = offsetClaimKey(root, suffix);
			// Read before the teardown: another run of this environment that
			// allocates during it rewrites the claim, and a read after would
			// take that run's claim for this one's.
			const read = readAllOffsetClaims()[key];
			return async () => {
				// Another run of this environment on record may still use the
				// block, and one that starts after this check claims it again:
				// released only if no run has used it since it was read.
				const runs = await readAllRuns();
				if (
					runs.some(
						(run) => run.projectName === projectName && run.root === root,
					)
				)
					return;
				// The block goes; the claim stays, naming the project its
				// volumes belong to.
				if (read !== undefined)
					await markOffsetClaimsReclaimed(
						{ [key]: read },
						new Date().toISOString(),
					);
				// A later start() on this environment allocates and claims again,
				// and nothing (Prisma's `allocate`) reads the released block as its
				// own.
				preparedSelection = undefined;
				startSelection = undefined;
			};
		},
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
					selectedRuntime,
					pick(services, plan.requiredServiceKeys),
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
			// The synchronous `prepareStart` does not reclaim: telling an idle
			// checkout from a running one needs the registry's liveness and a
			// container listing, so it throws the exhaustion with the holders.
			await allocateReclaiming(
				() => prepareStart(onlyApps, onlyServices, snapshot),
				signal,
			);
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
		output: TERMINAL_OUTPUT,

		assignedPortTargets(serviceKeys) {
			return assignedPortTargets(pick(services, serviceKeys), composeModel());
		},

		adoptAssignedPorts(hostPorts) {
			Object.assign(assignedHostPorts, hostPorts);
			Object.assign(portMap, hostPorts);
			refreshPorts();
		},

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

		composeModel,

		setNamedHostsActive(active, extras = {}) {
			if (!hosts) {
				return;
			}
			hosts.active = active;
			hosts.caPath = extras.caPath;
			hosts.tailscaleUrls = active ? (extras.tailscaleUrls ?? {}) : {};
			servedHostnames =
				active && extras.hostnames ? new Set(extras.hostnames) : undefined;
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
				urls,
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
