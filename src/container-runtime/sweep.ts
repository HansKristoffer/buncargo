/**
 * The sweep: remove every container stack nobody owns any more.
 *
 * Containers carry their project and checkout as labels, and every run that
 * owns containers has an entry in `~/.buncargo/runs.json`. Comparing the two
 * answers "is anyone using this?" for the whole machine from one listing and
 * one file, which is what lets the watchdog be a single process rather than
 * one per project, and what lets `ls` and `doctor` clean up after a watchdog
 * that was killed.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
	type CheckoutPresence,
	checkoutDeleted,
	checkoutPresence,
} from "../core/checkout-presence";
import { FileLockTimeoutError } from "../core/file-lock";
import {
	dropDeletedOffsetClaims,
	markDeletedOffsetClaims,
	type OffsetClaim,
	offsetClaimRoot,
	readAllOffsetClaims,
} from "../core/offset-claims";
import { execAsync } from "../core/process/exec";
import {
	clearRunStacks,
	markOwnersLost,
	type RunEntry,
	type RunStackEntry,
	readAllRuns,
	retireRuns,
	runLivenessAsync,
} from "../core/run-registry";
import { pruneDeletedCheckoutVolumes } from "../core/runtime-flags";
import { WATCHDOG_OWNER_DEAD_GRACE_MS } from "../core/watchdog-constants";
import type {
	BuncargoContainer,
	BuncargoVolume,
	ContainerRuntimeName,
} from "../types";
import {
	type ContainerGroup,
	groupBuncargoContainers,
	isContainerUp,
	manualDownCommand,
} from "./inventory";
import { withProjectLifecycleLock } from "./project-lock";
import {
	containerRuntimeCandidates,
	getContainerRuntimeAdapter,
} from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * How long a checkout must stay deleted, from the sweep's first sighting to a
 * later pass, before `BUNCARGO_PRUNE_DELETED_CHECKOUTS` removes its volumes.
 */
export const DELETED_CHECKOUT_SETTLE_MS = 10 * 60_000;

export interface SweepInput {
	/**
	 * This user's state names the stack: a run in `runs.json` or a port claim
	 * in `offsets.json` for its project and checkout. Nothing else is ours to
	 * remove (see {@link isKnownStack}).
	 */
	known: boolean;
	/**
	 * Whether the checkout the containers were started from is still there.
	 * Only `deleted` (confirmed missing) condemns a stack; `unknown`, a path
	 * this user cannot read, counts as there.
	 */
	checkout: CheckoutPresence;
	/** At least one container in the stack is running. */
	anyRunning: boolean;
	/** The run that owns them, or null when nothing on disk claims them. */
	run: RunEntry | null;
	ownerAlive: boolean;
	now: number;
}

export type SweepVerdict =
	| { kind: "keep" }
	| { kind: "down"; reason: string }
	/** Not this user's to remove; reported and left alone. */
	| { kind: "foreign"; reason: string };

function seconds(ms: number): string {
	return `${Math.ceil(ms / 1000)}s`;
}

/**
 * Whether a stack should be removed. Pure, so the policy is tested without
 * containers or minutes of waiting.
 */
export function decideSweep(
	input: SweepInput,
	limits: { ownerDeadGraceMs: number } = {
		ownerDeadGraceMs: WATCHDOG_OWNER_DEAD_GRACE_MS,
	},
): SweepVerdict {
	const { known, checkout, anyRunning, run, ownerAlive, now } = input;
	if (!known) return { kind: "foreign", reason: foreignReason(input) };
	// A live owner keeps its stack whatever the checkout looks like: a run
	// between `start()` and `startServers()` is using these containers.
	if (ownerAlive) return { kind: "keep" };
	if (checkout === "deleted")
		return { kind: "down", reason: "checkout deleted" };
	if (!anyRunning) return { kind: "down", reason: "stopped with no owner" };
	// Running, unowned, and nothing on record: an old CLI or a hand-started
	// stack. Only the two rules above may touch it.
	if (!run) return { kind: "keep" };

	// No hold at all means "as long as the checkout exists", however the run
	// ended: `--keep-containers`, a one-shot mode, or a script that brought a
	// stack up and exited, which to the sweep looks exactly like a crash.
	if (run.idleTimeoutMs === undefined) return { kind: "keep" };

	if (run.releasedAt !== undefined) {
		// A deliberate exit. Held so the next run reuses the containers rather
		// than recreating them.
		const idleFor = now - Date.parse(run.releasedAt);
		return idleFor >= run.idleTimeoutMs
			? { kind: "down", reason: `released ${seconds(idleFor)} ago` }
			: { kind: "keep" };
	}

	// The owner died without releasing: a crash, which leaves nobody to come
	// back for these. The grace counts from when a sweep first noticed; an
	// entry nobody has stamped yet was only just noticed.
	if (run.ownerLostAt === undefined) return { kind: "keep" };
	const lostFor = now - Date.parse(run.ownerLostAt);
	return lostFor >= limits.ownerDeadGraceMs
		? { kind: "down", reason: `owner gone for ${seconds(lostFor)}` }
		: { kind: "keep" };
}

/** Why a stack nobody here knows is still worth a look. */
function foreignReason({
	checkout,
	anyRunning,
}: Pick<SweepInput, "checkout" | "anyRunning">): string {
	if (checkout === "unknown") return "this user cannot read its checkout";
	if (checkout === "deleted") return "its checkout was deleted";
	return anyRunning ? "it is running" : "it is stopped";
}

/**
 * Whether this user's own state names a stack: a run in `runs.json` (any
 * session, live or not) or a port claim in `offsets.json` with its project
 * and checkout.
 *
 * Only such a stack may be removed. Several users can share one container
 * daemon, and a stack another user's buncargo started is listed here with
 * none of its runs: to this user it looks unowned, and its checkout,
 * under a home this user cannot read, looks deleted.
 */
export function isKnownStack(
	stack: { projectName: string; root: string },
	runs: readonly Pick<RunEntry, "projectName" | "root">[],
	claims: Record<string, OffsetClaim>,
): boolean {
	return (
		runs.some(
			(run) => run.projectName === stack.projectName && run.root === stack.root,
		) ||
		Object.entries(claims).some(
			([key, claim]) =>
				claim.projectName === stack.projectName &&
				offsetClaimRoot(key, claim) === stack.root,
		)
	);
}

/** A stack the sweep found and left alone because this user's state does not name it. */
export interface ForeignStack {
	projectName: string;
	root: string;
	runtime: ContainerRuntimeName;
	reason: string;
	/** What removes it by hand, if it really is orphaned. Keeps its volumes. */
	command: string;
}

function foreignStack(group: ContainerGroup, reason: string): ForeignStack {
	return {
		projectName: group.projectName,
		root: group.root,
		runtime: group.runtime,
		reason,
		command: manualDownCommand(group),
	};
}

export interface SweptStack {
	projectName: string;
	root: string;
	/** The container runtime, or the integration stack's name (`supabase`). */
	runtime: ContainerRuntimeName | string;
	reason: string;
}

export interface SweepResult {
	swept: SweptStack[];
	failed: { projectName: string; root: string; error: string }[];
	/** Buncargo containers found before sweeping, on every runtime that answered. */
	containers: number;
	/** Runs still alive, so the watchdog knows whether it has anything to watch. */
	liveRuns: number;
	/** Runs whose integration stacks are still recorded, so still to be stopped. */
	pendingStacks: number;
	/** The runtimes whose listing succeeded; an empty list means none is up. */
	answered: ContainerRuntimeName[];
	/** Stacks still standing afterwards, so a caller need not list again. */
	remaining: ContainerGroup[];
	/**
	 * Stacks this user's state does not name, so not this sweep's to remove:
	 * another user's buncargo on a shared daemon, or state that was wiped.
	 * Also in `remaining`.
	 */
	foreign: ForeignStack[];
	/** The registry as the sweep read it, and which of its sessions are live. */
	runs: RunEntry[];
	liveSessions: ReadonlySet<string>;
}

export interface SweepOptions {
	/** The project the caller itself is running; never touched. */
	except?: { projectName: string; root: string };
	/** Defaults to every backend, unprobed: a failed listing is the probe. */
	runtimes?: ContainerRuntimeAdapter[];
	now?: number;
}

/** The run that owns a stack: a live session if there is one, else the newest. */
function runFor(
	group: ContainerGroup,
	runs: RunEntry[],
	alive: (run: RunEntry) => boolean,
): RunEntry | null {
	const candidates = runs
		.filter(
			(run) => run.projectName === group.projectName && run.root === group.root,
		)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	// A live owner speaks for the stack even when a released entry is newer:
	// a second session in the same checkout keeps the containers alive.
	return candidates.find(alive) ?? candidates[0] ?? null;
}

/** The adapter to tear a group down with: the one that listed it, or the pinned binary. */
function adapterFor(
	group: ContainerGroup,
	runtimes: ContainerRuntimeAdapter[],
	run: RunEntry | null,
): ContainerRuntimeAdapter {
	const pinned = run?.services.find(
		(service) =>
			service.container?.runtime === group.runtime && service.container.binary,
	)?.container;
	if (pinned?.binary)
		return getContainerRuntimeAdapter(group.runtime, { binary: pinned.binary });
	return (
		runtimes.find((runtime) => runtime.name === group.runtime) ??
		getContainerRuntimeAdapter(group.runtime)
	);
}

/**
 * Tear down every unowned stack, then retire the entries left with nothing.
 *
 * Throws when the registry cannot be read. Nothing has been touched by then,
 * and guessing would be worse than stopping: with no registry every stack on
 * the machine looks unowned. The caller decides what a failed pass means —
 * the watchdog retries on its next tick.
 *
 * Each group is decided under its own project lock, so a run that is starting
 * holds the sweep off, and a lock that is busy simply means "someone is
 * working here": skip it this pass.
 */
export async function sweepOrphanedContainers(
	options: SweepOptions = {},
): Promise<SweepResult> {
	const runtimes = options.runtimes ?? containerRuntimeCandidates();
	const answered: ContainerRuntimeName[] = [];
	const containers: BuncargoContainer[] = [];
	for (const runtime of runtimes) {
		try {
			containers.push(...runtime.list());
			answered.push(runtime.name);
		} catch {
			// Not up, or not installed: it has nothing for us this pass.
		}
	}

	const runs = await readAllRuns();
	const claims = readAllOffsetClaims();
	const alive = await runLivenessAsync(runs);
	const now = options.now ?? Date.now();
	const groups = groupBuncargoContainers(containers);
	const owners = new Map(
		groups.map((group) => [group, runFor(group, runs, alive)]),
	);
	const stackRuns = runs.filter((run) => (run.stacks?.length ?? 0) > 0);
	await stampLostOwners([...owners.values(), ...stackRuns], alive, now);

	const result: SweepResult = {
		swept: [],
		failed: [],
		containers: containers.length,
		liveRuns: runs.filter(alive).length,
		pendingStacks: 0,
		answered,
		remaining: [],
		foreign: [],
		runs,
		liveSessions: new Set(runs.filter(alive).map((run) => run.sessionId)),
	};

	for (const group of groups) {
		const run = owners.get(group) ?? null;
		const excepted =
			options.except?.projectName === group.projectName &&
			options.except.root === group.root;
		const removed =
			!excepted &&
			(await sweepGroup(group, run, claims, alive, now, runtimes, result));
		if (!removed) result.remaining.push(group);
	}

	for (const run of stackRuns) {
		const excepted =
			options.except?.projectName === run.projectName &&
			options.except.root === run.root;
		if (!excepted) await sweepStacks(run, runs, alive, now, result);
	}
	result.pendingStacks = stackRuns.filter(
		(run) => (run.stacks?.length ?? 0) > 0,
	).length;

	try {
		await settleDeletedCheckouts({
			runtimes: runtimes.filter((runtime) => answered.includes(runtime.name)),
			runs,
			stacks: result.remaining,
			result,
			now,
		});
	} catch (error) {
		// A busy claims file: the deleted checkouts are still there next pass.
		if (!(error instanceof FileLockTimeoutError)) throw error;
	}

	try {
		await retireRuns(finishedSessions(runs, groups, answered, alive));
	} catch {
		// A busy registry: these are still finished next pass.
	}
	return result;
}

/**
 * Run a run's recorded stack `down` commands in order, each once the one
 * before it has succeeded.
 *
 * From the checkout, or from home once the checkout is gone: a deleted
 * worktree's stack must still come down.
 */
export async function runStackDowns(
	run: Pick<RunEntry, "root" | "stacks">,
	onDown: (stack: RunStackEntry) => void = () => {},
): Promise<void> {
	const cwd = existsSync(run.root) ? run.root : homedir();
	for (const stack of run.stacks ?? []) {
		await execAsync(stack.down, cwd, {}, { timeoutMs: 120_000 });
		onDown(stack);
	}
}

/**
 * Decide one stack and tear it down if it is condemned. True when removed.
 *
 * A stack condemned from the pass's snapshot is decided again from a fresh
 * read, under its lock, before anything is removed. The snapshot predates the
 * lock, and a new run publishes its claim before it takes the lock to reuse
 * these containers — so without the recheck, a pass busy with other stacks
 * could tear down containers a run had claimed in the meantime.
 */
async function sweepGroup(
	group: ContainerGroup,
	run: RunEntry | null,
	claims: Record<string, OffsetClaim>,
	alive: (run: RunEntry) => boolean,
	now: number,
	runtimes: ContainerRuntimeAdapter[],
	result: SweepResult,
): Promise<boolean> {
	const decide = (
		owner: RunEntry | null,
		isAlive: (run: RunEntry) => boolean,
		claims: Record<string, OffsetClaim>,
	) =>
		decideSweep({
			// `runFor` finds an owner exactly when a run on record names the stack.
			known: owner !== null || isKnownStack(group, [], claims),
			checkout: checkoutPresence(group.root),
			anyRunning: group.containers.some(isContainerUp),
			run: owner,
			ownerAlive: owner !== null && isAlive(owner),
			now,
		});
	const verdict = decide(run, alive, claims);
	if (verdict.kind === "foreign") {
		result.foreign.push(foreignStack(group, verdict.reason));
		return false;
	}
	if (verdict.kind !== "down") return false;

	try {
		return await withProjectLifecycleLock(
			group.projectName,
			group.root,
			async () => {
				const fresh = await readAllRuns();
				const freshAlive = await runLivenessAsync(fresh);
				const verdict = decide(
					runFor(group, fresh, freshAlive),
					freshAlive,
					readAllOffsetClaims(),
				);
				if (verdict.kind !== "down") return false;
				await adapterFor(group, runtimes, run).down({
					root: group.root,
					projectName: group.projectName,
					verbose: false,
				});
				result.swept.push({
					projectName: group.projectName,
					root: group.root,
					runtime: group.runtime,
					reason: verdict.reason,
				});
				return true;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		// A run is starting or stopping there; it will be decided next pass.
		if (!(error instanceof FileLockTimeoutError))
			result.failed.push({
				projectName: group.projectName,
				root: group.root,
				error: error instanceof Error ? error.message : String(error),
			});
		return false;
	}
}

/**
 * Settle the port claims of deleted checkouts: on the machine's opt-in
 * (`BUNCARGO_PRUNE_DELETED_CHECKOUTS=1`) remove their volumes first, then drop
 * the claims.
 *
 * Works from the claims rather than from container stacks, because by the
 * time a worktree is deleted its containers are usually long gone. A volume
 * names its Compose project, not its checkout, and two checkouts can share a
 * project name (a root below the repository's top level), so the project must
 * be nobody else's: no existing checkout claims it, no run on record for it
 * still has its checkout. A container of it still standing means its stack is
 * coming down; the next pass decides.
 *
 * A claim is also what makes its checkout's stack this user's to remove
 * ({@link isKnownStack}), so it stays while `stacks` (what is still listed)
 * holds one of its project and checkout: a stack whose removal failed, or
 * whose lock was busy, would otherwise be left to nobody.
 *
 * Volumes need more proof than containers: the checkout confirmed missing
 * (not merely unreadable) on two passes at least
 * {@link DELETED_CHECKOUT_SETTLE_MS} apart, the first stamped on the claim. A
 * path that is briefly missing, an unmounted disk or a worktree being
 * recreated, must not cost a database.
 */
export async function settleDeletedCheckouts(input: {
	runtimes: ContainerRuntimeAdapter[];
	runs: RunEntry[];
	stacks: readonly Pick<ContainerGroup, "projectName" | "root">[];
	result: Pick<SweepResult, "swept" | "failed">;
	now: number;
}) {
	const { runtimes, runs, stacks, result, now } = input;
	// With no runtime answering, nothing says whether its stack or its
	// volumes are left.
	if (runtimes.length === 0) return;
	// A checkout's suffixed environments (E2E, `buncargo ci`) have claims of
	// their own, each naming its own project.
	const claims = Object.entries(readAllOffsetClaims()).map(([key, claim]) => ({
		key,
		root: offsetClaimRoot(key, claim),
		claim,
	}));
	const deleted = claims.filter(
		({ root, claim }) =>
			checkoutDeleted(root) &&
			!stacks.some(
				(stack) =>
					stack.projectName === claim.projectName && stack.root === root,
			),
	);
	// A checkout that is back starts over: its next deletion is a first sighting.
	const back = claims.filter(
		({ root, claim }) =>
			claim.deletedSeenAt !== undefined && checkoutPresence(root) === "present",
	);
	if (deleted.length === 0 && back.length === 0) return;

	if (!pruneDeletedCheckoutVolumes()) {
		await markDeletedOffsetClaims({
			seen: [],
			back: back.map(({ key }) => key),
			at: new Date(now).toISOString(),
		});
		await dropDeletedOffsetClaims(deleted.map(({ key }) => key));
		return;
	}
	await markDeletedOffsetClaims({
		seen: deleted
			.filter(({ claim }) => claim.deletedSeenAt === undefined)
			.map(({ key }) => key),
		back: back.map(({ key }) => key),
		at: new Date(now).toISOString(),
	});
	if (deleted.length === 0) return;

	const containers: BuncargoContainer[] = [];
	const listings: {
		runtime: ContainerRuntimeAdapter;
		volumes: BuncargoVolume[];
	}[] = [];
	try {
		for (const runtime of runtimes) {
			containers.push(...runtime.list());
			listings.push({ runtime, volumes: await runtime.listVolumes() });
		}
	} catch {
		// A runtime that cannot answer could hold the project's containers.
		return;
	}

	const settled: string[] = [];
	for (const {
		key,
		root,
		claim: { projectName, deletedSeenAt },
	} of deleted) {
		const claimedElsewhere = claims.some(
			(other) =>
				other.claim.projectName === projectName && !checkoutDeleted(other.root),
		);
		const runElsewhere = runs.some(
			(run) => run.projectName === projectName && !checkoutDeleted(run.root),
		);
		if (claimedElsewhere || runElsewhere) {
			settled.push(key);
			continue;
		}

		const stackStillUp = containers.some(
			(container) => container.project === projectName,
		);
		if (stackStillUp) continue;

		// Seen deleted only on this pass, or too recently: a later one decides.
		const deletedFor =
			deletedSeenAt === undefined ? 0 : now - Date.parse(deletedSeenAt);
		if (!(deletedFor >= DELETED_CHECKOUT_SETTLE_MS)) continue;

		let refusedAny = false;
		for (const { runtime, volumes } of listings) {
			const ours = volumes
				.filter((volume) => volume.project === projectName)
				.map((volume) => volume.name);
			if (ours.length === 0) continue;

			const refused = await runtime.removeVolumes(ours);
			for (const { name, error } of refused) {
				refusedAny = true;
				result.failed.push({
					projectName,
					root,
					error: `volume ${name}: ${error}`,
				});
			}

			const removed = ours.filter(
				(name) => !refused.some((entry) => entry.name === name),
			);
			if (removed.length > 0)
				result.swept.push({
					projectName,
					root,
					runtime: runtime.name,
					reason: `checkout deleted, removed volumes ${removed.join(", ")}`,
				});
		}
		if (!refusedAny) settled.push(key);
	}
	await dropDeletedOffsetClaims(settled);
}

/**
 * Stop the integration stacks (the Supabase CLI's containers) a run recorded,
 * when the same policy would take its containers down.
 *
 * Those containers carry none of our labels, so no listing finds them: the
 * recorded `down` command is the only handle, and it is safe to run on a stack
 * that is already gone. So the stack counts as running, and only the hold, the
 * crash grace and a deleted checkout decide. Any live session in the checkout
 * shares the stack (it runs under the project's name) and keeps it.
 */
async function sweepStacks(
	run: RunEntry,
	runs: RunEntry[],
	alive: (run: RunEntry) => boolean,
	now: number,
	result: SweepResult,
): Promise<void> {
	const decide = (runs: RunEntry[], isAlive: (run: RunEntry) => boolean) => {
		const sameCheckout = runs.filter(
			(entry) =>
				entry.projectName === run.projectName && entry.root === run.root,
		);
		const owner =
			runs.find((entry) => entry.sessionId === run.sessionId) ?? null;
		return decideSweep({
			// Recorded by a run of this user's: known by definition.
			known: true,
			checkout: checkoutPresence(run.root),
			anyRunning: true,
			run: owner,
			ownerAlive: sameCheckout.some(isAlive),
			now,
		});
	};
	if (decide(runs, alive).kind !== "down") return;

	try {
		await withProjectLifecycleLock(
			run.projectName,
			run.root,
			async () => {
				const fresh = await readAllRuns();
				const freshAlive = await runLivenessAsync(fresh);
				const verdict = decide(fresh, freshAlive);
				if (verdict.kind !== "down") return;
				await runStackDowns(run, (stack) =>
					result.swept.push({
						projectName: run.projectName,
						root: run.root,
						runtime: stack.name,
						reason: verdict.reason,
					}),
				);
				await clearRunStacks([run.sessionId]);
				// Retirable this pass, like an entry whose containers are gone.
				run.stacks = undefined;
			},
			{ timeoutMs: 0 },
		);
	} catch (error) {
		if (!(error instanceof FileLockTimeoutError))
			result.failed.push({
				projectName: run.projectName,
				root: run.root,
				error: error instanceof Error ? error.message : String(error),
			});
	}
}

/**
 * Stamp the moment a stack's owner was first found gone.
 *
 * Written into the registry so the next pass counts from the same moment, and
 * onto the in-memory entry so this pass decides with it. A write that fails
 * leaves the entry unstamped, which reads as "only just noticed": the stack
 * waits a pass longer rather than coming down early.
 */
async function stampLostOwners(
	owners: readonly (RunEntry | null)[],
	alive: (run: RunEntry) => boolean,
	now: number,
): Promise<void> {
	const lost = [...new Set(owners)].filter(
		(run): run is RunEntry =>
			run !== null &&
			run.releasedAt === undefined &&
			run.ownerLostAt === undefined &&
			!alive(run),
	);
	if (lost.length === 0) return;
	const at = new Date(now).toISOString();
	try {
		await markOwnersLost(
			lost.map((run) => run.sessionId),
			at,
		);
	} catch {
		return;
	}
	for (const run of lost) run.ownerLostAt = at;
}

/**
 * Sessions whose containers are gone.
 *
 * Only when the runtime that holds them answered: from a daemon that is down,
 * an empty listing means "cannot tell", and retiring on that would throw away
 * the only record of a stack that is still there. A checkout that no longer
 * exists is the one case that needs no listing to be sure.
 */
function finishedSessions(
	runs: RunEntry[],
	groups: ContainerGroup[],
	answered: ContainerRuntimeName[],
	alive: (run: RunEntry) => boolean,
): string[] {
	const stillHasContainers = (run: RunEntry) =>
		groups.some(
			(group) =>
				group.projectName === run.projectName && group.root === run.root,
		);
	const runtimeAnswered = (run: RunEntry) => {
		const recorded = run.services.flatMap((service) =>
			service.container ? [service.container.runtime] : [],
		);
		return recorded.length > 0
			? recorded.every((name) => answered.includes(name))
			: answered.length > 0;
	};
	return runs
		.filter(
			(run) =>
				!alive(run) &&
				!stillHasContainers(run) &&
				// Its stacks are only recorded here; retiring would orphan them.
				(run.stacks?.length ?? 0) === 0 &&
				(runtimeAnswered(run) || checkoutDeleted(run.root)),
		)
		.map((run) => run.sessionId);
}
