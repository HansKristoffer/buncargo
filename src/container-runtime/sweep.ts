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
import { FileLockTimeoutError } from "../core/file-lock";
import {
	markOwnersLost,
	type RunEntry,
	readAllRuns,
	retireRuns,
	runLiveness,
} from "../core/run-registry";
import { WATCHDOG_OWNER_DEAD_GRACE_MS } from "../core/watchdog-constants";
import type { BuncargoContainer, ContainerRuntimeName } from "../types";
import {
	type ContainerGroup,
	groupBuncargoContainers,
	isContainerUp,
} from "./inventory";
import { withProjectLifecycleLock } from "./project-lock";
import {
	containerRuntimeCandidates,
	getContainerRuntimeAdapter,
} from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

export interface SweepInput {
	/** The checkout the containers were started from still exists. */
	rootExists: boolean;
	/** At least one container in the stack is running. */
	anyRunning: boolean;
	/** The run that owns them, or null when nothing on disk claims them. */
	run: RunEntry | null;
	ownerAlive: boolean;
	now: number;
}

export type SweepVerdict = { kind: "keep" } | { kind: "down"; reason: string };

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
	const { rootExists, anyRunning, run, ownerAlive, now } = input;
	if (!rootExists) return { kind: "down", reason: "checkout deleted" };
	if (ownerAlive) return { kind: "keep" };
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

export interface SweptStack {
	projectName: string;
	root: string;
	runtime: ContainerRuntimeName;
	reason: string;
}

export interface SweepResult {
	swept: SweptStack[];
	failed: { projectName: string; root: string; error: string }[];
	/** Buncargo containers found before sweeping, on every runtime that answered. */
	containers: number;
	/** Runs still alive, so the watchdog knows whether it has anything to watch. */
	liveRuns: number;
	/** The runtimes whose listing succeeded; an empty list means none is up. */
	answered: ContainerRuntimeName[];
	/** Stacks still standing afterwards, so a caller need not list again. */
	remaining: ContainerGroup[];
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
	const alive = runLiveness(runs);
	const now = options.now ?? Date.now();
	const groups = groupBuncargoContainers(containers);
	const owners = new Map(
		groups.map((group) => [group, runFor(group, runs, alive)]),
	);
	await stampLostOwners(owners, alive, now);

	const result: SweepResult = {
		swept: [],
		failed: [],
		containers: containers.length,
		liveRuns: runs.filter(alive).length,
		answered,
		remaining: [],
		runs,
		liveSessions: new Set(runs.filter(alive).map((run) => run.sessionId)),
	};

	for (const group of groups) {
		const run = owners.get(group) ?? null;
		const excepted =
			options.except?.projectName === group.projectName &&
			options.except.root === group.root;
		const removed =
			!excepted && (await sweepGroup(group, run, alive, now, runtimes, result));
		if (!removed) result.remaining.push(group);
	}

	try {
		await retireRuns(finishedSessions(runs, groups, answered, alive));
	} catch {
		// A busy registry: these are still finished next pass.
	}
	return result;
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
	alive: (run: RunEntry) => boolean,
	now: number,
	runtimes: ContainerRuntimeAdapter[],
	result: SweepResult,
): Promise<boolean> {
	const decide = (
		owner: RunEntry | null,
		isAlive: (run: RunEntry) => boolean,
	) =>
		decideSweep({
			rootExists: group.root !== "" && existsSync(group.root),
			anyRunning: group.containers.some(isContainerUp),
			run: owner,
			ownerAlive: owner !== null && isAlive(owner),
			now,
		});
	if (decide(run, alive).kind !== "down") return false;

	try {
		return await withProjectLifecycleLock(
			group.projectName,
			group.root,
			async () => {
				const fresh = await readAllRuns();
				const freshAlive = runLiveness(fresh);
				const verdict = decide(runFor(group, fresh, freshAlive), freshAlive);
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
 * Stamp the moment a stack's owner was first found gone.
 *
 * Written into the registry so the next pass counts from the same moment, and
 * onto the in-memory entry so this pass decides with it. A write that fails
 * leaves the entry unstamped, which reads as "only just noticed": the stack
 * waits a pass longer rather than coming down early.
 */
async function stampLostOwners(
	owners: Map<ContainerGroup, RunEntry | null>,
	alive: (run: RunEntry) => boolean,
	now: number,
): Promise<void> {
	const lost = [...new Set(owners.values())].filter(
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
				(runtimeAnswered(run) || !existsSync(run.root)),
		)
		.map((run) => run.sessionId);
}
