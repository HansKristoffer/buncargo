import { availableParallelism } from "node:os";
import { basename } from "node:path";
import { isCI, typecheckConcurrencyOverride } from "../core/runtime-flags";

export const LOCAL_TYPECHECK_CONCURRENCY_CAP = 4;
export const CI_TYPECHECK_CONCURRENCY_CAP = 2;

export interface RankedWorkspace {
	path: string;
	fileCount: number;
}

/**
 * Longest expected job first so the pool's last slot is a short leftover,
 * not the backend.
 *
 * Recorded durations win. A workspace with no timing is sorted after every
 * timed one, then by descending file count among the untimed (the cold-CI
 * case, when the cache is empty).
 */
export function sortWorkspacesByExpectedDuration<T extends RankedWorkspace>(
	workspaces: readonly T[],
	timings: Readonly<Record<string, number>>,
): T[] {
	return [...workspaces].sort((a, b) => {
		const aTime = timings[a.path];
		const bTime = timings[b.path];
		const aTimed = aTime !== undefined;
		const bTimed = bTime !== undefined;
		if (aTimed && bTimed) return bTime - aTime;
		if (aTimed !== bTimed) return aTimed ? -1 : 1;
		return b.fileCount - a.fileCount;
	});
}

/**
 * How many typecheck processes to run at once.
 *
 * CLI `--concurrency` is applied by the caller. Here the env override wins
 * over the CPU-derived default; CI is capped at 2 so several native `tsc`
 * processes do not OOM a 7 GB runner.
 */
export function defaultTypecheckConcurrency(
	env: NodeJS.ProcessEnv = process.env,
	parallelism: number = availableParallelism(),
): number {
	const override = typecheckConcurrencyOverride(env);
	if (override !== undefined) return override;
	const cap = isCI(env)
		? CI_TYPECHECK_CONCURRENCY_CAP
		: LOCAL_TYPECHECK_CONCURRENCY_CAP;
	return Math.min(Math.max(1, parallelism), cap);
}

/**
 * `--only` matches a workspace path (`apps/platform`) or its basename
 * (`platform`). Unknown names are returned so the caller can fail loudly.
 *
 * Selected workspaces keep the incoming order (already longest-first).
 */
export function selectWorkspaces<T extends { path: string }>(
	workspaces: readonly T[],
	only: readonly string[],
): { selected: T[]; unknown: string[] } {
	const unknown: string[] = [];
	const wanted = new Set<string>();

	for (const name of only) {
		const match = workspaces.find(
			(workspace) =>
				workspace.path === name || basename(workspace.path) === name,
		);
		if (!match) {
			unknown.push(name);
			continue;
		}
		wanted.add(match.path);
	}

	return {
		selected: workspaces.filter((workspace) => wanted.has(workspace.path)),
		unknown,
	};
}
