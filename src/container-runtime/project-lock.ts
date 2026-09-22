import { withFileLock } from "../core/file-lock";
import { simpleHash } from "../core/hash";
import { stateFilePath } from "../core/state-paths";

/**
 * The gate between starting, stopping and sweeping one project's containers.
 *
 * Keyed on project *and* checkout, because two worktrees of the same repo are
 * two independent stacks. Everything that creates or destroys a container for
 * a project holds this, so a sweep can never tear down a stack a run is in the
 * middle of starting, and two runs in one checkout cannot both reconcile it.
 *
 * Deliberately not tied to any liveness record: it is mutual exclusion over
 * the containers, not a claim on them.
 */
export function projectLockPath(projectName: string, root: string): string {
	const hash = simpleHash(root).toString(16).slice(0, 8);
	return stateFilePath(`locks/${projectName}-${hash}.lifecycle`);
}

export function withProjectLifecycleLock<T>(
	projectName: string,
	root: string,
	operation: () => Promise<T>,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
	return withFileLock(projectLockPath(projectName, root), operation, {
		timeoutMs: options.timeoutMs ?? 120_000,
		signal: options.signal,
	});
}
