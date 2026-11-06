import { releaseLeases } from "../core/leases";
import type { StartDevServersOptions } from "../core/process/dev-servers";
import {
	flushRunPatches,
	markApps,
	markServices,
	publishCurrentRun,
	type RunSource,
	recordAppSpawn,
} from "../core/run-publish";
import {
	buildRunEntryAsync,
	holdToInherit,
	loadRuns,
	publishRun,
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
	 * entry goes, and so does any finished session for the same checkout
	 * whose containers were all on this runtime (`heldOnlyOn`). Releasing
	 * instead left entries for a later sweep to find empty. `containersDown`
	 * says whether the teardown downed this runtime's containers at all.
	 */
	retireRun(options: { containersDown: boolean }): Promise<void>;
	/**
	 * The named services came up and were waited for: their rows read `ready`.
	 * The CLI's describe says so too; a library `start()` that spawns no apps
	 * describes nothing, and its services read `starting` for the whole run.
	 */
	servicesReady(serviceKeys: readonly string[]): void;
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
	/**
	 * After a start that failed: give back what its `claimApps` newly took,
	 * named by the apps that call returned. Concurrent starts each give back
	 * their own.
	 */
	abandonApps(apps: Record<string, AppConfig>): Promise<void>;
	/**
	 * After the apps have stopped: give back everything they held, and
	 * withdraw an entry that only listed them.
	 */
	releaseApps(): Promise<void>;
}

type ClaimState = { kind: "unclaimed" } | { kind: "claimed"; at: number };

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
	// The containers' claim. Released and retired alike end it: a later
	// `claimRun` claims afresh, and `claimedAt` is the current claim's.
	let claim: ClaimState = { kind: "unclaimed" };
	const claimed = () => claim.kind === "claimed";
	// Leases this session holds.
	const heldLeases = new Set<string>();
	// The apps on this session's entry.
	const listedApps: Record<string, AppConfig> = {};
	// What each `claimApps` call newly took, by the record it returned, so a
	// failed start gives back its own and not a concurrent one's.
	const newlyClaimed = new WeakMap<
		Record<string, AppConfig>,
		{ leases: string[]; apps: string[] }
	>();

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
		if (claimed() || listsApps()) return;
		await releaseRun(sessionId);
	}

	// The hold of the last claim. `restart()` retires and then claims again
	// with only a signal, and resolving that afresh dropped a hold the first
	// claim asked for, which kept the containers forever.
	let lastHold:
		{ value: number | undefined; inherited: number | undefined } | undefined;

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
			return claim.kind === "claimed" ? claim.at : undefined;
		},

		async claimRun(options = {}) {
			if (claimed() || !ctx.hasSelectedServices) return;
			const namesHold =
				options.idleTimeoutMs !== undefined ||
				options.defaultIdleTimeoutMs !== undefined;
			const hold =
				lastHold && !namesHold
					? lastHold.value
					: resolveClaimHold(options, ctx.config.options?.autoShutdown);
			// Asked for no hold at all (a library `start()`): a stack another
			// run left in its hold keeps that hold after this run ends.
			let inherited: number | undefined;
			if (!namesHold)
				inherited = lastHold
					? lastHold.inherited
					: holdToInherit(await loadRuns(), ctx);
			lastHold = { value: hold, inherited };
			const stacks = stackEntries();
			// Claimed before it is published: a write that fails must not be
			// retried on every container subset.
			claim = { kind: "claimed", at: Date.now() };
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
				...(hold === undefined && inherited !== undefined
					? { inheritedIdleTimeoutMs: inherited }
					: {}),
				services: serviceEntries(),
				...(stacks.length > 0 ? { stacks } : {}),
			});
		},

		async releaseRun() {
			// Not guarded on `claimed`: the CLI publishes app-only runs that the
			// library never claimed, and those entries have to be withdrawn by
			// the same call. The registry decides which of the two this is, from
			// whether the entry owns services.
			claim = { kind: "unclaimed" };
			await releaseRun(sessionId);
		},

		async retireRun({ containersDown }) {
			claim = { kind: "unclaimed" };
			await retireProjectRuns({
				projectName: ctx.projectName,
				root: ctx.root,
				sessionId,
				downed: containersDown
					? [{ runtime: ctx.runtime.name, binary: ctx.runtimeBinary }]
					: [],
			});
		},

		servicesReady(serviceKeys) {
			void markServices(session, serviceKeys, "ready");
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
			const added = Object.keys(leases.apps).filter(
				(name) => !(name in listedApps),
			);
			newlyClaimed.set(leases.apps, { leases: leases.acquired, apps: added });
			if (added.length === 0) return leases.apps;

			Object.assign(listedApps, leases.apps);
			// Over the claim, if there is one: its services, as `dev` lists them.
			// The describe keeps each listed row's process and state.
			await flushRunPatches(session);
			await publishCurrentRun(source(), {
				apps: listedApps,
				serviceNames: claimed() ? ctx.selectedServiceKeys : [],
			});
			return leases.apps;
		},

		appEvents: {
			onAppSpawned: (name, pid, attached) => {
				void recordAppSpawn(session, name, pid, attached);
			},
			onAppReady: (name) => {
				void markApps(session, [name], "ready");
			},
			onAppExit: (name, _code, _signal, state) => {
				void markApps(session, [name], state);
			},
			onAppRestartFailed: (name) => {
				void markApps(session, [name], "failed");
			},
		},

		async abandonApps(apps) {
			const taken = newlyClaimed.get(apps);
			if (!taken) return;
			newlyClaimed.delete(apps);
			for (const key of taken.leases) heldLeases.delete(key);
			for (const name of taken.apps) delete listedApps[name];
			await Promise.all([
				releaseLeases(sessionId, { keys: taken.leases }),
				taken.apps.length > 0 ? withdrawAppOnlyEntry() : undefined,
			]);
		},

		async releaseApps() {
			const listed = listsApps();
			for (const name of Object.keys(listedApps)) delete listedApps[name];
			const leases = heldLeases.size > 0;
			heldLeases.clear();
			await Promise.all([
				leases ? releaseLeases(sessionId) : undefined,
				listed ? withdrawAppOnlyEntry() : undefined,
			]);
		},
	};
}
