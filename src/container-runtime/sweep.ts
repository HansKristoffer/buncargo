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
	isRunAlive,
	type RunEntry,
	readAllRuns,
	retireRuns,
} from "../core/run-registry";
import { WATCHDOG_OWNER_DEAD_GRACE_MS } from "../core/watchdog-constants";
import type { ContainerRuntimeName } from "../types";
import {
	type ContainerGroup,
	groupBuncargoContainers,
	isContainerUp,
	listBuncargoContainers,
} from "./inventory";
import { withProjectLifecycleLock } from "./project-lock";
import {
	availableContainerRuntimes,
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

	if (run.releasedAt !== undefined) {
		// A deliberate exit. Held so the next run reuses the containers rather
		// than recreating them; no hold at all means "as long as the checkout".
		if (run.idleTimeoutMs === undefined) return { kind: "keep" };
		const idleFor = now - Date.parse(run.releasedAt);
		return idleFor >= run.idleTimeoutMs
			? { kind: "down", reason: `released ${seconds(idleFor)} ago` }
			: { kind: "keep" };
	}

	// The owner died without releasing: a crash, which leaves nobody to come
	// back for these. Measured from the last time the entry was written, not
	// from the death itself — see WATCHDOG_OWNER_DEAD_GRACE_MS for why the
	// registry is not rewritten on a timer to make that exact.
	const staleFor = now - Date.parse(run.updatedAt);
	return staleFor >= limits.ownerDeadGraceMs
		? { kind: "down", reason: `owner gone, idle ${seconds(staleFor)}` }
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
}

export interface SweepOptions {
	/** The project the caller itself is running; never touched. */
	except?: { projectName: string; root: string };
	runtimes?: ContainerRuntimeAdapter[];
	now?: number;
}

/** The run that owns a stack: the newest entry for this project and checkout. */
function runFor(group: ContainerGroup, runs: RunEntry[]): RunEntry | null {
	const candidates = runs
		.filter(
			(run) => run.projectName === group.projectName && run.root === group.root,
		)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	// A live owner speaks for the stack even when a released entry is newer:
	// a second session in the same checkout keeps the containers alive.
	return candidates.find(isRunAlive) ?? candidates[0] ?? null;
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
 * Each group is decided under its own project lock, so a run that is starting
 * holds the sweep off, and a lock that is busy simply means "someone is
 * working here": skip it this pass.
 */
export async function sweepOrphanedContainers(
	options: SweepOptions = {},
): Promise<SweepResult> {
	const runtimes = options.runtimes ?? availableContainerRuntimes();
	const containers = listBuncargoContainers(runtimes);
	const runs = await readAllRuns();
	const now = options.now ?? Date.now();
	const result: SweepResult = {
		swept: [],
		failed: [],
		containers: containers.length,
		liveRuns: runs.filter(isRunAlive).length,
	};

	const groups = groupBuncargoContainers(containers);
	for (const group of groups) {
		if (
			options.except &&
			group.projectName === options.except.projectName &&
			group.root === options.except.root
		)
			continue;
		const run = runFor(group, runs);
		try {
			await withProjectLifecycleLock(
				group.projectName,
				group.root,
				async () => {
					const verdict = decideSweep({
						rootExists: group.root !== "" && existsSync(group.root),
						anyRunning: group.containers.some(isContainerUp),
						run,
						ownerAlive: run !== null && isRunAlive(run),
						now,
					});
					if (verdict.kind !== "down") return;
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
				},
				{ timeoutMs: 0 },
			);
		} catch (error) {
			// A run is starting or stopping there; it will be decided next pass.
			if (error instanceof FileLockTimeoutError) continue;
			result.failed.push({
				projectName: group.projectName,
				root: group.root,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	await retireFinishedRuns(runs, groups, runtimes);
	return result;
}

/**
 * Drop entries whose containers are gone.
 *
 * Only ever with a runtime that answered: with every runtime down, an empty
 * listing means "cannot tell", and retiring on that would throw away the only
 * record of a stack that is still there. A checkout that no longer exists is
 * the one case that needs no listing to be sure.
 */
async function retireFinishedRuns(
	runs: RunEntry[],
	groups: ContainerGroup[],
	runtimes: ContainerRuntimeAdapter[],
): Promise<void> {
	const stillHasContainers = (run: RunEntry) =>
		groups.some(
			(group) =>
				group.projectName === run.projectName && group.root === run.root,
		);
	const finished = runs.filter(
		(run) =>
			!isRunAlive(run) &&
			!stillHasContainers(run) &&
			(runtimes.length > 0 || !existsSync(run.root)),
	);
	if (finished.length === 0) return;
	await retireRuns(
		finished.map((run) => ({
			root: run.root,
			pid: run.pid,
			sessionId: run.sessionId,
		})),
	);
}
