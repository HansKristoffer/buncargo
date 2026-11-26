import { mapValues, startTimer } from "hanzio";
import type { ContainerRuntimeAdapter } from "../container-runtime";
import type { SkippedLeaseApp } from "../core/app-leases";
import {
	allowedHostsOf,
	type EgressGuardProxy,
	guardsApp,
	guardsTask,
	startEgressGuardProxy,
} from "../core/egress-guard";
import { watchLinks } from "../core/link-watch";
import { appsToRestartForLinks, hasReactiveLinks } from "../core/links";
import { selectReactiveTasks } from "../core/process";
import { buildApps } from "../core/process/build";
import type { StartDevServersOptions } from "../core/process/dev-servers";
import type { CapturedValue } from "../core/process/output-capture";
import { loadAppSecrets } from "../core/secrets/index";
import { formatDone, formatWarn } from "../core/style";
import type {
	DevServerPids,
	ResolvedApp,
	ResolvedEgressGuardConfig,
	ResolvedLinkConfig,
	SeedOutcome,
	SeedRunOptions,
	TaskConfig,
} from "../types";
import { type LeasePolicy, libraryLeasePolicy } from "./app-leases";
import type { StartSelection } from "./context";
import type { DevRunClaimApi } from "./run-claim";
import { startServerSession } from "./server-session";
import { assertAppWorkingDirectories } from "./servers";

/**
 * What preparation decided about the seed. `overlap`: `spawn()` runs it
 * beside the apps. `after-apps`: `spawn()` runs it once `apps` are ready
 * (blocking remaining apps unless `beforeOtherApps` is false). `ran`:
 * preparation ran it, with this outcome. `none`: the start leaves it out
 * (`seed: "skip"`, a mode that stops before it, or its prerequisites are not
 * selected), or `seed.check` said it is not needed.
 */
export type PreparedSeed =
	| { readonly kind: "overlap" }
	| {
			readonly kind: "after-apps";
			readonly apps: readonly string[];
			readonly beforeOtherApps: boolean;
			readonly force: boolean;
	  }
	| { readonly kind: "ran"; readonly outcome: SeedOutcome }
	| { readonly kind: "none" };

/** What `prepare()` hands `claimApps()` and `spawn()`: the selection, and what it decided. */
export interface Prepared {
	readonly selection: StartSelection;
	/** The selection's apps, `requiredApps` expanded. */
	readonly apps: Record<string, ResolvedApp>;
	readonly hasServices: boolean;
	readonly productionBuild: boolean;
	readonly verbose: boolean;
	/** Whether this run starts the machine-wide watchdog. */
	readonly watchdog: boolean;
	readonly seed: PreparedSeed;
	readonly onPhase?: (name: string, durationMs: number) => void;
}

/** The apps a start is about to spawn, their leases taken and their rows published. */
interface Claimed {
	readonly prepared: Prepared;
	readonly apps: Record<string, ResolvedApp>;
	/** Apps already running in another terminal that this run reuses. */
	readonly reusedNames: readonly string[];
	/** `essential: false` apps left out: another run holds their lease. */
	readonly skipped: readonly SkippedLeaseApp[];
}

interface ClaimAppsOptions {
	/** The apps to spawn. Default: every prepared app. */
	apps?: Record<string, ResolvedApp>;
	/** Apps another process runs, which this run uses. */
	reused?: Record<string, ResolvedApp>;
	attached?: string;
	/** Default: {@link libraryLeasePolicy}. */
	leasePolicy?: LeasePolicy;
	signal?: AbortSignal;
}

/** What `spawn()` passes on to the supervisor; the rest it owns. */
type SpawnOptions = Omit<
	StartDevServersOptions,
	| "onCapture"
	| "afterAppsTask"
	| "verbose"
	| "productionBuild"
	| "projectName"
	| "runtime"
	| "skipContainers"
	| "onPhase"
	| "unsetEnv"
> & {
	onCapture?: (app: string, captured: CapturedValue) => void | Promise<void>;
	/** Keep a session with no app to spawn open, for tunnels or sharing. */
	stayOpen?: (signal: AbortSignal) => Promise<void>;
	/** Work beside the seed before the apps spawn. */
	prepare?: (signal: AbortSignal) => Promise<void>;
	/** The apps and an overlapping seed are all ready. */
	onSeedReady?: () => void;
};

/** What the app phases read from their environment. */
export interface AppPipelineDeps {
	readonly root: string;
	readonly ports: Readonly<Record<string, number>>;
	readonly projectName: string;
	readonly unsetEnv: readonly string[] | undefined;
	readonly egressGuard: ResolvedEgressGuardConfig | undefined;
	readonly linksConfig?: Readonly<Record<string, ResolvedLinkConfig>>;
	/** Full configured apps map so reactive tasks can resolve `task.app`'s `cwd` even when reused. */
	readonly allApps?: Readonly<Record<string, Pick<ResolvedApp, "cwd">>>;
	readonly tasks?: Readonly<Record<string, TaskConfig>>;
	readonly hasGeneratedFiles?: boolean;
	readonly hasActiveEgressProxy?: () => boolean;
	/** The run's active egress proxy, which learns `allowHostsOf` hosts per process. */
	readonly egressProxy?: () => EgressGuardProxy | undefined;
	setEgressProxy(proxy: EgressGuardProxy | undefined): Promise<void>;
	runtime(): ContainerRuntimeAdapter;
	appEnv(name: string, production: boolean): Record<string, string>;
	/** Build full env (active profile, live URLs, resolved secrets) for one reactive task run. */
	buildTaskEnv?(
		task: TaskConfig,
		production: boolean,
		signal: AbortSignal,
	): Promise<Record<string, string>>;
	/** `beforeServers`/`afterServers`/`afterServersStop`, told the prepared selection. Returns whether a hook ran. */
	runHook(
		phase: "before" | "after" | "afterStop",
		signal?: AbortSignal,
	): Promise<boolean>;
	/** Integration post-readiness hook for one app, before downstream waves proceed. */
	onAppReady?(name: string, signal?: AbortSignal): Promise<void>;
	waitForHealth(
		apps: Record<string, ResolvedApp>,
		production: boolean,
		signal?: AbortSignal,
	): Promise<void>;
	recordCapture(
		app: string,
		captured: CapturedValue,
	): Promise<readonly string[]>;
	/** The paths whose content changed. */
	renderGeneratedFiles(): string[];
	runSeed(options: SeedRunOptions): Promise<SeedOutcome>;
	readonly claim: Pick<
		DevRunClaimApi,
		"claimApps" | "appEvents" | "abandonApps" | "flushPatches"
	>;
	/** Not awaited; says its own failure. */
	ensureWatchdog(): void;
	/** The pids this environment's `stop()` stops. */
	readonly ownedServerPids: Record<string, number>;
}

export interface AppPipeline {
	claimApps(prepared: Prepared, options?: ClaimAppsOptions): Promise<Claimed>;
	spawn(claimed: Claimed, options?: SpawnOptions): Promise<DevServerPids>;
}

/**
 * The phases after preparation, shared by `start()`, `startServers()` and
 * `buncargo dev`: leases and app rows (`claimApps`), then the apps, their
 * hooks, health, captures, the overlapping seed and the app-only watchdog
 * (`spawn`). Callers add only what they show and how they ask.
 */
export function createAppPipeline(deps: AppPipelineDeps): AppPipeline {
	async function claimApps(
		prepared: Prepared,
		options: ClaimAppsOptions = {},
	): Promise<Claimed> {
		const apps = options.apps ?? prepared.apps;
		options.signal?.throwIfAborted();
		assertAppWorkingDirectories(apps, deps.root, prepared.productionBuild);

		const claimed = await deps.claim.claimApps(apps, {
			policy: options.leasePolicy ?? libraryLeasePolicy,
			serviceNames: prepared.hasServices
				? prepared.selection.requiredServiceKeys
				: [],
			reused: options.reused,
			attached: options.attached,
			production: prepared.productionBuild,
			signal: options.signal,
		});

		return {
			prepared,
			apps: claimed.apps,
			reusedNames: Object.keys(options.reused ?? {}),
			skipped: claimed.skipped,
		};
	}

	async function spawn(
		claimed: Claimed,
		options: SpawnOptions = {},
	): Promise<DevServerPids> {
		const { prepared, apps } = claimed;
		const { productionBuild, onPhase } = prepared;
		const { output } = options;

		// A run's output (the CLI's stream or TUI, and its logs) is where the
		// session says what it does: spawns, reuse, the seed's lines. It shows
		// them whatever `verbose` says, which is about the terminal.
		const verbose = output !== undefined || prepared.verbose;

		const runSeed = (signal: AbortSignal, force = false) => {
			const elapsed = startTimer();
			return deps
				.runSeed({
					productionBuild,
					signal,
					verbose,
					force,
					// Through the run's output when it has one, so stream mode and
					// the TUI both show it and write it to the run's `seed.log`.
					...(output
						? { onOutputLine: (line: string) => output.line("seed", line) }
						: { prefixOutput: true }),
				})
				.finally(() => onPhase?.("seed", elapsed()));
		};
		const afterAppsSeed =
			prepared.seed.kind === "after-apps" ? prepared.seed : undefined;
		const selectedAppSet = new Set([
			...Object.entries(apps)
				.filter(([, app]) => app.devCommand !== false)
				.map(([name]) => name),
			...claimed.reusedNames,
		]);
		const selectedServiceSet = new Set(prepared.selection.requiredServiceKeys);
		const reactiveTaskMap = selectReactiveTasks(
			deps.tasks,
			selectedAppSet,
			selectedServiceSet,
		);
		const buildTaskEnv = deps.buildTaskEnv;
		const reactiveTasks =
			options.reactiveTasks === false
				? false
				: (options.reactiveTasks ??
					(Object.keys(reactiveTaskMap).length > 0 && buildTaskEnv
						? {
								tasks: reactiveTaskMap,
								apps: deps.allApps ?? apps,
								buildEnv: (task: TaskConfig, taskSignal: AbortSignal) =>
									buildTaskEnv(task, productionBuild, taskSignal),
								initialReadyApps: claimed.reusedNames,
							}
						: undefined));

		const announceEgress = (text: string) => {
			if (output) {
				output.announce("egress", text, {
					raw: formatWarn(text),
					level: "warn",
				});
			} else if (verbose) {
				console.warn(formatWarn(text));
			}
		};

		let startedProxy: EgressGuardProxy | undefined;
		const guard = deps.egressGuard;
		const needsEgressProxy =
			guard?.enabled === true &&
			!deps.hasActiveEgressProxy?.() &&
			(Object.keys(apps).some((name) => guardsApp(guard, name)) ||
				Object.values(reactiveTaskMap).some((task) => guardsTask(guard, task)));
		if (needsEgressProxy && guard) {
			startedProxy = await startEgressGuardProxy({
				allow: guard.allow,
				mode: guard.mode,
				onBlocked: (event) => {
					const action = event.mode === "block" ? "Blocked" : "Allowed (warn)";
					announceEgress(
						`${action} outbound ${event.method} to ${event.host}:${event.port} (add "${event.host}" to egressGuard.allow to permit)`,
					);
				},
			});
			await deps.setEgressProxy(startedProxy);
		}

		// `allowHostsOf`: each guarded app's hosts, once its secrets are in its env.
		const reportedKeys = new Set<string>();
		const learnEgressHosts = (
			name: string,
			env: Readonly<Record<string, string>>,
		) => {
			if (!guard || guard.allowHostsOf.length === 0) return;
			if (!guardsApp(guard, name)) return;
			const proxy = deps.egressProxy?.();
			if (!proxy) return;

			const { hosts, unresolved } = allowedHostsOf(guard.allowHostsOf, {
				...process.env,
				...env,
			});
			proxy.allowHosts(hosts);
			for (const key of unresolved) {
				if (reportedKeys.has(`${name}|${key}`)) continue;
				reportedKeys.add(`${name}|${key}`);
				announceEgress(
					`egressGuard.allowHostsOf: ${name} has no URL in ${key}, so no host is let through for it. Add ${key} to ${name}'s secrets or env.`,
				);
			}
		};

		try {
			const pids = await startServerSession(
				{
					root: deps.root,
					ports: deps.ports,
					// Restarts rebuild env so captures and public URLs are current.
					appEnv: (name) => deps.appEnv(name, productionBuild),
					runHook: deps.runHook,
					onAppReady: deps.onAppReady,
					// One app at a time, quietly: the spawner reports readiness.
					waitForHealth: (app, signal) =>
						deps.waitForHealth(app, productionBuild, signal),
					recordCapture: deps.recordCapture,
					afterWave: () => {
						for (const path of deps.renderGeneratedFiles()) {
							if (verbose) console.log(formatDone(`Updated ${path}`));
						}
					},
					prepare: async (signal) => {
						if (productionBuild) await buildForProduction(apps, signal);
						await options.prepare?.(signal);
					},
					onSeedReady: options.onSeedReady,
				},
				apps,
				{
					...options,
					verbose,
					productionBuild,
					projectName: deps.projectName,
					runtime: prepared.hasServices ? deps.runtime() : undefined,
					skipContainers: !prepared.hasServices,
					unsetEnv: deps.unsetEnv,
					onPhase,
					seed: prepared.seed.kind === "overlap" ? runSeed : undefined,
					afterAppsSeed: afterAppsSeed
						? {
								apps: afterAppsSeed.apps,
								beforeOtherApps: afterAppsSeed.beforeOtherApps,
								run: (signal) => runSeed(signal, afterAppsSeed.force),
							}
						: undefined,
					reactiveTasks,
					onAppEnv: learnEgressHosts,
					deferPublicUrlApps: options.deferPublicUrlApps ?? false,
					onAppPhase: (name, life, previous) => {
						if (life.pid !== undefined) deps.ownedServerPids[name] = life.pid;
						deps.claim.appEvents.onAppPhase?.(name, life, previous);
						return options.onAppPhase?.(name, life, previous);
					},
					onReadyWatch: (controls, watchSignal) => {
						options.onReadyWatch?.(controls, watchSignal);
						const linksConfig = deps.linksConfig;
						if (!linksConfig) return;
						const activeLinks = Object.values(linksConfig).some(
							(spec) => !spec.disabled,
						);
						if (!activeLinks) return;
						const shouldWatch =
							hasReactiveLinks(apps, linksConfig) ||
							deps.hasGeneratedFiles === true;
						if (!shouldWatch) return;

						let linkQueue = Promise.resolve();
						watchLinks({
							root: deps.root,
							linksConfig,
							signal: watchSignal,
							onChange: (changedAliases) => {
								linkQueue = linkQueue
									.then(async () => {
										if (watchSignal.aborted) return;
										for (const path of deps.renderGeneratedFiles()) {
											if (verbose) {
												controls.announce("buncargo", `Updated ${path}`);
											}
										}

										const ownedNames = new Set(controls.ownedApps());
										const ownedApps = Object.fromEntries(
											Object.entries(apps).filter(([name]) =>
												ownedNames.has(name),
											),
										);
										const toRestart = appsToRestartForLinks(
											ownedApps,
											linksConfig,
											changedAliases,
										);
										for (const item of toRestart) {
											if (watchSignal.aborted) return;
											const label = item.links.join(", ");
											await controls.restart(
												item.app,
												`link "${label}" changed`,
											);
										}
									})
									.catch((error: unknown) => {
										if (watchSignal.aborted) return;
										const message =
											error instanceof Error ? error.message : String(error);
										console.warn(
											formatWarn(`Reactive link reload failed: ${message}`),
										);
									});
							},
						});
					},
					onReady: async (signal) => {
						// A run without containers is in the registry for its apps,
						// and the watchdog is what lists live runs to BuncargoBar on
						// the tailnet. Once they are up, so startup pays nothing.
						if (!prepared.hasServices && prepared.watchdog) {
							deps.ensureWatchdog();
						}
						await options.onReady?.(signal);
					},
				},
			);
			Object.assign(deps.ownedServerPids, pids);
			// Ensure queued `ready` patches reach `runs.json` before `start()` resolves,
			// so a dependent script or linked checkout immediately observes ready apps.
			await deps.claim.flushPatches();

			return pids;
		} catch (error) {
			if (startedProxy) await deps.setEgressProxy(undefined);
			await deps.claim.abandonApps(apps);
			throw error;
		} finally {
			// A supervised session (`buncargo dev`) owns the proxy for its duration;
			// a handed-off library `start()` closes it in `env.stop()`.
			if (startedProxy && options.waitForExit) {
				await deps.setEgressProxy(undefined);
			}
		}

		/**
		 * The spawn path gets its secrets inside `startDevServers`; a production
		 * build is the other process that needs them, and it runs before that.
		 * Both share one fetch per scope through the module's cache.
		 */
		async function buildForProduction(
			apps: Record<string, ResolvedApp>,
			signal: AbortSignal,
		): Promise<void> {
			const secrets = await loadAppSecrets(apps, {
				signal,
				onWait: (ms) => onPhase?.("secrets", ms),
			});
			const buildEnv = mapValues(apps, (_app, name) => ({
				...secrets[name],
				...deps.appEnv(name, true),
			}));
			await buildApps(apps, deps.root, buildEnv, {
				verbose,
				signal,
				unsetEnv: deps.unsetEnv,
			});
		}
	}

	return { claimApps, spawn };
}
