import type { SweepResult } from "../container-runtime/sweep";
import { stateFilePath } from "./state-paths";

export interface WatchdogLoopDeps {
	sweep: () => Promise<SweepResult>;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
	intervalMs: number;
	/**
	 * Asked when a pass finds nothing to watch: `true` to exit, `false` when a
	 * run has claimed since that pass read the registry. See
	 * {@link exitUnlessClaimed}.
	 */
	exitIfIdle: () => Promise<boolean>;
}

/**
 * Held by a caller while it starts a watchdog, so only one ever does, and by
 * a runner while it exits (see {@link exitUnlessClaimed}).
 *
 * Distinct from the runner's own lock, and it has to be: the runner holds
 * that one for its whole life, so a spawner cannot keep it across the spawn
 * without deadlocking the process it just started. Without this second file
 * two callers each spawn a runner, and the loser — which exits silently on
 * the lock it cannot get — can instead start *after* the winner has been
 * stopped, and quietly become the watchdog nobody asked for.
 *
 * Here rather than in `watchdog.ts`, a public subpath, because the runner
 * needs it too. It sits next to the pid file, as the runner's lock does.
 */
export function getWatchdogSpawnLockFile(): string {
	return stateFilePath("watchdog.pid.spawn");
}

export interface WatchdogExitDeps {
	/** Run `operation` holding {@link getWatchdogSpawnLockFile}. */
	withSpawnLock: (operation: () => Promise<void>) => Promise<void>;
	removePidFile: () => void;
	restorePidFile: () => void;
	/** Whether the registry, read now, holds a live run. */
	hasLiveRuns: () => Promise<boolean>;
}

/**
 * Decide under the spawn lock whether the runner may exit and, when it may,
 * keep holding that lock: the runner releases its own lock and exits, and
 * only then can a caller of `ensureWatchdog` start the next one.
 *
 * A run claims and then calls `ensureWatchdog`, which spawns nothing while it
 * sees this runner's pid file or lock. Exiting on the pass's registry read
 * left a run that claimed after that read with no watchdog: it found this
 * one still up, and this one then left. Here the pid file goes first and the
 * registry is read again after it, so a claim either shows in that read or
 * comes from a caller that will find no pid file, wait for this lock, and
 * spawn once this process is gone.
 *
 * The runner never takes this lock at start, only here, so it cannot
 * deadlock with a spawner: one that holds it only try-acquires the runner's
 * lock and polls for the pid file. A registry that cannot be read keeps the
 * runner watching.
 */
export function exitUnlessClaimed(deps: WatchdogExitDeps): Promise<boolean> {
	return new Promise((resolve, reject) => {
		deps
			.withSpawnLock(async () => {
				deps.removePidFile();
				const claimed = await deps.hasLiveRuns().catch(() => true);
				if (claimed) {
					deps.restorePidFile();
					return;
				}
				resolve(true);
				// Held until the process exits.
				await new Promise<never>(() => {});
			})
			.then(() => resolve(false), reject);
	});
}

/**
 * The watchdog's loop: sweep, report, wait, until nothing is left to watch.
 *
 * Separate from the runner, which starts a process as a side effect of being
 * imported, so the loop can be tested on its own.
 *
 * A pass that throws is logged and retried, never fatal. The usual causes — a
 * registry caught mid-write, a lock another process holds a moment too long,
 * a daemon restarting — clear up by themselves, and a watchdog that exited on
 * them left nothing sweeping until the next buncargo command.
 *
 * A failure is logged when it first appears and again only if it changes, so
 * one stack that cannot come down does not write the same line every pass for
 * as long as the machine is up.
 */
export async function runWatchdogLoop(deps: WatchdogLoopDeps): Promise<void> {
	let reportedFailures = new Map<string, string>();
	let reportedPassError: string | undefined;

	while (true) {
		try {
			const result = await deps.sweep();
			reportedPassError = undefined;
			for (const stack of result.swept)
				deps.log(
					`Removed ${stack.projectName} (${stack.root}): ${stack.reason}`,
				);

			const failures = new Map<string, string>();
			for (const failure of result.failed) {
				const key = `${failure.projectName}\t${failure.root}`;
				failures.set(key, failure.error);
				if (reportedFailures.get(key) !== failure.error)
					deps.log(`Could not remove ${failure.projectName}: ${failure.error}`);
			}
			reportedFailures = failures;

			if (
				result.containers === 0 &&
				result.liveRuns === 0 &&
				result.pendingStacks === 0
			) {
				if (await deps.exitIfIdle()) {
					deps.log("Nothing left to watch; exiting");
					return;
				}
				deps.log("A run claimed while exiting; still watching");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== reportedPassError)
				deps.log(`Sweep failed, retrying next pass: ${message}`);
			reportedPassError = message;
		}
		await deps.sleep(deps.intervalMs);
	}
}
