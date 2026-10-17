import { releaseLeases } from "../core/leases";
import type { StartDevServersOptions } from "../core/process/dev-servers";
import { appExitState } from "../core/process/process-owner";
import {
	flushRunPatches,
	markApps,
	publishCurrentRun,
	type RunSource,
	recordAppSpawn,
} from "../core/run-publish";
import {
	buildRunEntryAsync,
	publishRun,
	type RunAppStatus,
	type RunServiceEntry,
	type RunStackEntry,
	releaseRun,
	retireProjectRuns,
} from "../core/run-registry";
import { ensureWatchdog as ensureWatchdogFn } from "../core/watchdog";
import type { AnyDevConfig, AppConfig, ServiceConfig } from "../types";
import { acquireStartLeases } from "./app-leases";
import type { DevEnvContext } from "./context";
import { stacksForServices } from "./stacks";

/**
 * A run's claim on its containers.
 *
 * Claiming is how a process says "these containers are mine": an entry in
 * `~/.buncargo/runs.json`, published *before* the first container exists so
 * the sweep can never see a fresh stack as unowned. Releasing marks the entry
 * finished and leaves it there, which is what the idle hold is measured from.
 *
 * The library claims too, not just the CLI. A `dev.start()` from a script
 * owns containers exactly as a `buncargo dev` does, and used to be invisible
 * to everything that reads this registry. The apps it spawns are claimed the
 * same way: their leases, and rows in the entry that `ls`, `stop` and
 * BuncargoBar read, published as `buncargo dev` publishes them.
 */
export interface DevRunClaimApi {
	/** The session this environment publishes under. Stable for its lifetime. */
	readonly sessionId: string;
	/** When the current claim was published (epoch ms), or `undefined` before one. */
	readonly claimedAt: number | undefined;
	/**
	 * Claim the selected services' containers for this process.
	 *
	 * Idempotent, so the CLI can claim first with its flags and `start()` can
	 * claim again with the defaults without changing anything.
	 */
	claimRun(options?: ClaimOptions): Promise<void>;
	/** Release the claim: containers are held for the idle timeout, then removed. */
	releaseRun(): Promise<void>;
	/**
	 * Drop the claim outright, after an explicit teardown.
	 *
	 * The containers are gone, so there is nothing to hold: this session's
	 * entry goes, and so does any finished session for the same checkout.
	 * Releasing instead left entries for a later sweep to find empty.
	 */
	retireRun(): Promise<void>;
	/** Start the machine-wide watchdog unless it is already running. */
	ensureWatchdog(): Promise<void>;
	/**
	 * Claim what the apps about to spawn need from the machine: each one's
	 * `exclusive` lease, then this session's entry listing them, published
	 * like `buncargo dev`'s (an app-only run has no entry until here).
	 * Returns the apps to spawn, without an `essential: false` one whose
	 * lease another run holds; an essential one throws instead.
	 */
	claimApps(
		apps: Record<string, AppConfig>,
		signal?: AbortSignal,
	): Promise<Record<string, AppConfig>>;
	/** What the spawner reports, recorded on the claimed apps' rows. */
	readonly appEvents: Pick<
		StartDevServersOptions,
		"onAppSpawned" | "onAppReady" | "onAppExit" | "onAppRestartFailed"
	>;
	/** After a start that failed: give back what its `claimApps` newly took. */
	abandonApps(): Promise<void>;
	/**
	 * After the apps have stopped: give back everything they held, and
	 * withdraw an entry that only listed them.
	 */
	releaseApps(): Promise<void>;
}

export interface ClaimOptions {
	signal?: AbortSignal;
	/** The hold asked for explicitly; `false` keeps the containers. */
	idleTimeoutMs?: number | false;
	/** The hold when neither this nor `options.autoShutdown` says one. */
	defaultIdleTimeoutMs?: number | false;
}

/**
 * How long a run's containers outlive it, or `undefined` to keep them for as
 * long as the checkout exists.
 *
 * An explicit request wins. Otherwise only a caller that brings a default —
 * the CLI, with its three minutes — gets a hold, and `options.autoShutdown`
 * overrides that default. A library `start()` brings none, so it keeps: a
 * script that brings a database up and ends is indistinguishable, to the
 * sweep, from one that crashed, and any hold would tear its containers down
 * seconds after a perfectly ordinary exit. A script that wants cleanup asks
 * with `claimRun({ idleTimeoutMs })` before starting.
 */
export function resolveClaimHold(
	options: ClaimOptions,
	configured: number | false | undefined,
): number | undefined {
	const hold =
		options.idleTimeoutMs ??
		(options.defaultIdleTimeoutMs === undefined
			? false
			: (configured ?? options.defaultIdleTimeoutMs));
	return hold === false ? undefined : hold;
}

export function createRunClaimApi<
	TServices extends Record<string, ServiceConfig>,
	TApps extends Record<string, AppConfig>,
>(
	ctx: DevEnvContext<TServices, TApps>,
	/** The environment, which the app rows are built from. */
	source: () => RunSource,
): DevRunClaimApi {
	const sessionId = crypto.randomUUID();
	const session = { sessionId };
	let claimed = false;
	// Leases this session holds, and those the last `claimApps` took.
	const heldLeases = new Set<string>();
	let lastAcquired: string[] = [];
	// The apps on this session's entry, and those the last `claimApps` added.
	const listedApps: Record<string, AppConfig> = {};
	let lastListed: string[] = [];
	// What each listed app's row last said, to say again when a later
	// `claimApps` publishes the entry afresh with every row `starting`.
	const rows = new Map<
		string,
		{ pid?: number; attached?: boolean; status?: RunAppStatus }
	>();

	function recordRow(
		name: string,
		row: { pid?: number; attached?: boolean; status?: RunAppStatus },
	): void {
		rows.set(name, { ...rows.get(name), ...row });
		if (row.pid !== undefined)
			void recordAppSpawn(session, name, row.pid, row.attached ?? false);
		if (row.status !== undefined) void markApps(session, [name], row.status);
	}

	function listsApps(): boolean {
		return Object.keys(listedApps).length > 0;
	}

	/**
	 * Withdraw an entry that lists only apps, once none is left. One with
	 * services is the containers' record: `stop()` retires it, `releaseRun()`
	 * releases it.
	 */
	async function withdrawAppOnlyEntry(): Promise<void> {
		await flushRunPatches(session);
		if (claimed || listsApps()) return;
		await releaseRun(sessionId);
	}
	let claimedAt: number | undefined;
	// The hold of the last claim. `restart()` retires and then claims again
	// with only a signal, and resolving that afresh dropped a hold the first
	// claim asked for, which kept the containers forever.
	let lastHold: { value: number | undefined } | undefined;

	function serviceEntries(): RunServiceEntry[] {
		return ctx.selectedServiceKeys.map((name) => {
			const service = ctx.services[name] as ServiceConfig | undefined;
			const composeName = service?.serviceName ?? name;
			return {
				name,
				kind: service?.kind,
				status: "starting" as const,
				// A stack's own CLI names its containers; `stop` cannot reach one.
				...(service?.external
					? { stack: service.external.stack }
					: {
							container: {
								runtime: ctx.runtime.name,
								binary: ctx.runtimeBinary,
								service: composeName,
								name: `${ctx.projectName}-${composeName}`,
							},
						}),
			};
		});
	}

	function stackEntries(): RunStackEntry[] {
		return stacksForServices(
			ctx.config as AnyDevConfig,
			ctx.selectedServiceKeys,
		).map(({ name, stack }) => ({
			name,
			down: [
				...stack.down({
					projectName: ctx.projectName,
					root: ctx.root,
					removeVolumes: false,
				}),
			],
		}));
	}

	return {
		sessionId,
		get claimedAt() {
			return claimedAt;
		},

		async claimRun(options = {}) {
			if (claimed || !ctx.hasSelectedServices) return;
			const namesHold =
				options.idleTimeoutMs !== undefined ||
				options.defaultIdleTimeoutMs !== undefined;
			const hold =
				lastHold && !namesHold
					? lastHold.value
					: resolveClaimHold(options, ctx.config.options?.autoShutdown);
			lastHold = { value: hold };
			const stacks = stackEntries();
			// Claimed before it is published: a write that fails must not be
			// retried on every container subset.
			claimed = true;
			claimedAt = Date.now();
			await publishRun({
				...(await buildRunEntryAsync(
					{
						sessionId,
						projectPrefix: ctx.config.projectPrefix,
						projectName: ctx.projectName,
						root: ctx.root,
						isWorktree: ctx.worktree,
					},
					options.signal,
				)),
				...(hold === undefined ? {} : { idleTimeoutMs: hold }),
				services: serviceEntries(),
				...(stacks.length > 0 ? { stacks } : {}),
			});
		},

		async releaseRun() {
			// Not guarded on `claimed`: the CLI publishes app-only runs that the
			// library never claimed, and those entries have to be withdrawn by
			// the same call. The registry decides which of the two this is, from
			// whether the entry owns services.
			claimed = false;
			await releaseRun(sessionId);
		},

		async retireRun() {
			claimed = false;
			await retireProjectRuns({
				projectName: ctx.projectName,
				root: ctx.root,
				sessionId,
			});
		},

		ensureWatchdog() {
			return ensureWatchdogFn();
		},

		async claimApps(apps, signal) {
			const leases = await acquireStartLeases(
				{
					sessionId,
					projectName: ctx.projectName,
					root: ctx.root,
					isWorktree: ctx.worktree,
				},
				apps,
				{ held: heldLeases, signal },
			);
			for (const key of leases.acquired) heldLeases.add(key);
			lastAcquired = leases.acquired;
			lastListed = Object.keys(leases.apps).filter(
				(name) => !(name in listedApps),
			);
			if (lastListed.length === 0) return leases.apps;

			Object.assign(listedApps, leases.apps);
			// Over the claim, if there is one: its services, as `dev` lists them.
			await flushRunPatches(session);
			await publishCurrentRun(source(), {
				apps: listedApps,
				serviceNames: claimed ? ctx.selectedServiceKeys : [],
			});
			for (const [name, row] of rows) recordRow(name, row);
			return leases.apps;
		},

		appEvents: {
			onAppSpawned: (name, pid, attached) => {
				recordRow(name, { pid, attached });
			},
			onAppReady: (name) => {
				recordRow(name, { status: "ready" });
			},
			onAppExit: (name, code, signal) => {
				const app = listedApps[name];
				recordRow(name, {
					status: appExitState(code, signal, {
						worker: app?.kind === "worker",
						optional: app?.essential === false,
					}),
				});
			},
			onAppRestartFailed: (name) => {
				recordRow(name, { status: "failed" });
			},
		},

		async abandonApps() {
			const keys = lastAcquired;
			lastAcquired = [];
			for (const key of keys) heldLeases.delete(key);
			const names = lastListed;
			lastListed = [];
			for (const name of names) {
				delete listedApps[name];
				rows.delete(name);
			}
			await Promise.all([
				releaseLeases(sessionId, { keys }),
				names.length > 0 ? withdrawAppOnlyEntry() : undefined,
			]);
		},

		async releaseApps() {
			lastAcquired = [];
			lastListed = [];
			const listed = listsApps();
			for (const name of Object.keys(listedApps)) delete listedApps[name];
			rows.clear();
			const leases = heldLeases.size > 0;
			heldLeases.clear();
			await Promise.all([
				leases ? releaseLeases(sessionId) : undefined,
				listed ? withdrawAppOnlyEntry() : undefined,
			]);
		},
	};
}
