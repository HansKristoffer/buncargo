import { mapValues, startTimer } from "hanzio";
import type { ContainerRuntimeAdapter } from "../container-runtime";
import type { SkippedLeaseApp } from "../core/app-leases";
import { buildApps } from "../core/process/build";
import type { StartDevServersOptions } from "../core/process/dev-servers";
import type { CapturedValue } from "../core/process/output-capture";
import { loadAppSecrets } from "../core/secrets/index";
import { formatDone } from "../core/style";
import type {
	DevServerPids,
	ResolvedApp,
	SeedOutcome,
	SeedRunOptions,
} from "../types";
import { type LeasePolicy, libraryLeasePolicy } from "./app-leases";
import type { StartSelection } from "./context";
import type { DevRunClaimApi } from "./run-claim";
import { startServerSession } from "./server-session";
import { assertAppWorkingDirectories } from "./servers";

/**
 * What preparation decided about the seed. `overlap`: `spawn()` runs it
 * beside the apps. `ran`: preparation ran it, with this outcome. `none`: the
 * start leaves it out (`seed: "skip"`, a mode that stops before it, or its
 * services are not selected), or `seed.check` said it is not needed.
 */
export type PreparedSeed =
	| { readonly kind: "overlap" }
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
	runtime(): ContainerRuntimeAdapter;
	appEnv(name: string, production: boolean): Record<string, string>;
	/** `beforeServers`/`afterServers`, told the prepared selection. */
	runHook(phase: "before" | "after", signal?: AbortSignal): Promise<void>;
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
		"claimApps" | "appEvents" | "abandonApps"
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
			signal: options.signal,
		});
		return { prepared, apps: claimed.apps, skipped: claimed.skipped };
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
		const runSeed = (signal: AbortSignal) => {
			const elapsed = startTimer();
			return deps
				.runSeed({
					productionBuild,
					signal,
					verbose,
					// Through the run's output when it has one, so stream mode and
					// the TUI both show it and write it to the run's `seed.log`.
					...(output
						? { onOutputLine: (line: string) => output.line("seed", line) }
						: { prefixOutput: true }),
				})
				.finally(() => onPhase?.("seed", elapsed()));
		};

		try {
			const pids = await startServerSession(
				{
					root: deps.root,
					ports: deps.ports,
					// Restarts rebuild env so captures and public URLs are current.
					appEnv: (name) => deps.appEnv(name, productionBuild),
					runHook: deps.runHook,
					// One app at a time, quietly: the spawner reports readiness.
					waitForHealth: (app, signal) =>
						deps.waitForHealth(app, productionBuild, signal),
					recordCapture: deps.recordCapture,
					afterWave: () => {
						for (const path of deps.renderGeneratedFiles())
							if (verbose) console.log(formatDone(`Updated ${path}`));
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
					deferPublicUrlApps: options.deferPublicUrlApps ?? false,
					onAppPhase: (name, life, previous) => {
						if (life.pid !== undefined) deps.ownedServerPids[name] = life.pid;
						deps.claim.appEvents.onAppPhase?.(name, life, previous);
						return options.onAppPhase?.(name, life, previous);
					},
					onReady: async (signal) => {
						// A run without containers is in the registry for its apps,
						// and the watchdog is what lists live runs to BuncargoBar on
						// the tailnet. Once they are up, so startup pays nothing.
						if (!prepared.hasServices && prepared.watchdog)
							deps.ensureWatchdog();
						await options.onReady?.(signal);
					},
				},
			);
			Object.assign(deps.ownedServerPids, pids);
			return pids;
		} catch (error) {
			await deps.claim.abandonApps(apps);
			throw error;
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
