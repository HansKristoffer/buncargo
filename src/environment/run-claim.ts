import type { SkippedLeaseApp } from "../core/app-leases";
import { releaseLeases } from "../core/leases";
import { externalStackProjectName } from "../core/ports";
import type { StartDevServersOptions } from "../core/process/dev-servers";
import {
	appRowEvents,
	flushRunPatches,
	markServices,
	publishCurrentRun,
	type RunSource,
} from "../core/run-publish";
import {
	buildRunEntryAsync,
	CHECKOUT_HOLD,
	holdToInherit,
	loadRuns,
	publishRun,
	type RunHold,
	type RunServiceEntry,
	type RunStackEntry,
	releaseRun,
	retireProjectRuns,
} from "../core/run-registry";
import { ensureWatchdog as ensureWatchdogFn } from "../core/watchdog";
import type { ResolvedApp, ResolvedService } from "../types";
import { acquireStartLeases, type LeasePolicy } from "./app-leases";
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
	 * Idempotent, so a script can claim first with its hold and `start()`
	 * can claim again with the defaults without changing anything.
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
	 * `exclusive` lease, then this session's entry listing them beside the
	 * `reused` ones (an app-only run has no entry until here). Returns the
	 * apps to spawn, without an `essential: false` one whose lease another
	 * run holds and the policy left alone; an essential one throws instead.
	 */
	claimApps(
		apps: Record<string, ResolvedApp>,
		options: AppClaimOptions,
	): Promise<{
		apps: Record<string, ResolvedApp>;
		skipped: SkippedLeaseApp[];
	}>;
	/** What the spawner reports, recorded on the claimed apps' rows. */
	readonly appEvents: Pick<
		StartDevServersOptions,
		keyof ReturnType<typeof appRowEvents>
	>;
	/**
	 * After a start that failed: give back what its `claimApps` newly took,
	 * named by the apps that call returned. Concurrent starts each give back
	 * their own.
	 */
	abandonApps(apps: Record<string, ResolvedApp>): Promise<void>;
	/**
	 * After the apps have stopped: give back everything they held, and
	 * withdraw an entry that only listed them.
	 */
	releaseApps(): Promise<void>;
}

type ClaimState = { kind: "unclaimed" } | { kind: "claimed"; at: number };

interface AppClaimOptions {
	policy: LeasePolicy;
	/** The services the entry lists, with the apps. */
	serviceNames: readonly string[];
	/** Apps another process runs, which this run uses: listed `reused`. */
	reused?: Record<string, ResolvedApp>;
	/** The app that owns the terminal, when one does. */
	attached?: string;
	signal?: AbortSignal;
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

export function createRunClaimApi(
	ctx: DevEnvContext,
	/** The environment, which the app rows are built from. */
	source: () => RunSource,
): DevRunClaimApi {
	const sessionId = crypto.randomUUID();
	const session = { sessionId };
	// The containers' claim. Released and retired alike end it: a later
	// `claimRun` claims afresh, and `claimedAt` is the current claim's.
	let claim: ClaimState = { kind: "unclaimed" };
	const claimed = () => claim.kind === "claimed";
	// The services this claim has reported `ready`.
	const reportedReady = new Set<string>();
	// Leases this session holds.
	const heldLeases = new Set<string>();
	// The apps on this session's entry.
	const listedApps: Record<string, ResolvedApp> = {};
	// What each `claimApps` call newly took, by the record it returned, so a
	// failed start gives back its own and not a concurrent one's.
	const newlyClaimed = new WeakMap<
		Record<string, ResolvedApp>,
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

	// The hold of the last claim. A later claim that names none (a `start()`
	// after a `stop()`) keeps it: resolving that afresh dropped a hold the
	// first claim asked for, which kept the containers forever.
	let lastHold: RunHold | undefined;

	/**
	 * The hold a claim asks for: the one named, or, when none is (a library
	 * `start()`), the hold of a stack another run left in its hold, which
	 * applies after this run ends too.
	 */
	async function claimHold(options: ClaimOptions): Promise<RunHold> {
		const namesHold =
			options.idleTimeoutMs !== undefined ||
			options.defaultIdleTimeoutMs !== undefined;
		if (!namesHold) return lastHold ?? holdToInherit(await loadRuns(), ctx);
		const ms = resolveClaimHold(options, ctx.config.options?.autoShutdown);
		return ms === undefined
			? CHECKOUT_HOLD
			: { kind: "timed", ms, inherited: false };
	}

	function serviceEntries(): RunServiceEntry[] {
		return ctx.selectedServiceKeys.map((name) => {
			const service = ctx.services[name] as ResolvedService | undefined;
			const composeName = service?.serviceName ?? name;
			return {
				name,
				kind: service?.kind === "job" ? ("job" as const) : undefined,
				status: "starting" as const,
				// A stack's own CLI names its containers; `stop` cannot reach one.
				...(service?.kind === "external"
					? { stack: service.stack }
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
		return stacksForServices(ctx.config, ctx.selectedServiceKeys).map(
			({ name, stack }) => ({
				name,
				down: [
					...stack.down({
						projectName: ctx.projectName,
						root: ctx.root,
						removeVolumes: false,
					}),
				],
				composeProject: externalStackProjectName(ctx.projectName),
			}),
		);
	}

	return {
		sessionId,
		get claimedAt() {
			return claim.kind === "claimed" ? claim.at : undefined;
		},

		async claimRun(options = {}) {
			if (claimed()) {
				// Another `start()` under this claim ensures its services again:
				// `starting` first, so a service `buncargo stop` stopped meanwhile
				// can read `ready` again (the registry never lets `ready` undo
				// `stopped` on its own).
				if (reportedReady.size > 0)
					void markServices(session, [...reportedReady], "starting");
				reportedReady.clear();
				return;
			}
			if (!ctx.hasSelectedServices) return;
			const hold = await claimHold(options);
			lastHold = hold;
			const stacks = stackEntries();
			const at = Date.now();
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
				hold,
				services: serviceEntries(),
				...(stacks.length > 0 ? { stacks } : {}),
			});
			// Only once the entry is on disk: a claim that failed to publish
			// (aborted, a lock timeout, a newer registry) is retried by the next
			// start, which would otherwise create containers nobody claimed.
			claim = { kind: "claimed", at };
		},

		async releaseRun() {
			// Not guarded on `claimed`: the CLI publishes app-only runs that the
			// library never claimed, and those entries have to be withdrawn by
			// the same call. The registry decides which of the two this is, from
			// whether the entry owns services.
			claim = { kind: "unclaimed" };
			reportedReady.clear();
			await releaseRun(sessionId);
		},

		async retireRun({ containersDown }) {
			claim = { kind: "unclaimed" };
			reportedReady.clear();
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
			for (const key of serviceKeys) reportedReady.add(key);
			void markServices(session, serviceKeys, "ready");
		},

		ensureWatchdog() {
			return ensureWatchdogFn();
		},

		async claimApps(apps, options) {
			const reused = options.reused ?? {};
			const leases = await acquireStartLeases(
				{
					sessionId,
					projectName: ctx.projectName,
					root: ctx.root,
					isWorktree: ctx.worktree,
				},
				apps,
				{ held: heldLeases, policy: options.policy, signal: options.signal },
			);
			for (const key of leases.acquired) heldLeases.add(key);
			const added = Object.keys(leases.apps).filter(
				(name) => !(name in listedApps),
			);
			newlyClaimed.set(leases.apps, { leases: leases.acquired, apps: added });
			const claimedApps = { apps: leases.apps, skipped: leases.skipped };
			Object.assign(listedApps, leases.apps);
			const listed = { ...listedApps, ...reused };
			// An entry would describe nothing: no app and no service.
			if (Object.keys(listed).length === 0 && options.serviceNames.length === 0)
				return claimedApps;

			// Over the claim, if there is one: its services, as `dev` lists them.
			// The describe keeps each listed row's process and state.
			await flushRunPatches(session);
			await publishCurrentRun(source(), {
				apps: listed,
				reusedNames: Object.keys(reused),
				serviceNames: options.serviceNames,
				attached: options.attached,
			});
			return claimedApps;
		},

		appEvents: appRowEvents(session),

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
