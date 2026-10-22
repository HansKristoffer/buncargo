import { getErrorMessage } from "hanzio";
import { foreignStackOf } from "../container-runtime/foreign-stack";
import type { SweepResult, SweptStack } from "../container-runtime/sweep";
import type { RunEntry } from "./run-registry";
import { stateFilePath } from "./state-paths";

export interface WatchdogLoopDeps {
	sweep: () => Promise<SweepResult>;
	/**
	 * Take out the Tailscale Serve entries of runs that have ended, before the
	 * containers. Reports rather than throws.
	 */
	sweepServeEntries: () => Promise<{ removed: string[]; failures: string[] }>;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
	intervalMs: number;
	/**
	 * Asked with a pass that found nothing to watch: `true` to exit, `false`
	 * when a run has claimed since that pass read the registry. See
	 * {@link exitUnlessClaimed}.
	 */
	exitIfIdle: (pass: SweepResult) => Promise<boolean>;
	/**
	 * Why the watchdog has outlived what it was started for, or undefined
	 * while it has not: its state directory confirmed gone (a test's
	 * temporary HOME, whose registry can name nothing any more), or the test
	 * run it may not outlive ended. It stops rather than sweep on what an
	 * empty registry says.
	 */
	outlived?: () => string | undefined;
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
	/** Whether the registry, read now, holds a run to stay for: {@link claimedSincePass}. */
	hasLiveRuns: () => Promise<boolean>;
}

/**
 * Whether a registry read after an idle pass holds a run that pass did not
 * account for: one live now, or a session the pass never saw. A run that
 * claimed after the pass read the registry and has since released or crashed
 * is no longer live, but its containers are still there for the next pass.
 */
export function claimedSincePass(
	pass: Pick<SweepResult, "runs">,
	fresh: readonly RunEntry[],
	alive: (run: RunEntry) => boolean,
): boolean {
	const seen = new Set(pass.runs.map((run) => run.sessionId));
	return fresh.some((run) => alive(run) || !seen.has(run.sessionId));
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
 * One line of `watchdog.log`, saying which watchdog wrote it.
 *
 * Every line, not only the first: one watchdog sweeps for every checkout on
 * the machine, whichever buncargo started it, and a line read on its own has
 * to say that a 12.4.0 runner from another worktree did this.
 */
export function formatWatchdogLine(
	self: { pid: number; version?: string },
	at: Date,
	message: string,
): string {
	return `[watchdog ${self.version ?? "unknown version"} pid ${self.pid}] ${at.toISOString()} ${message}`;
}

/**
 * A removal, with the run it was decided against: "Removed demo's
 * containers (/repo, docker): owner gone for 16s; its run: session s1, pid
 * 4242, worktree feature, branch feature/login".
 */
export function describeSwept(stack: SweptStack): string {
	const what = stack.volumes
		? `volumes ${stack.volumes.join(", ")}`
		: "containers";
	const owner = stack.owner
		? [
				`session ${stack.owner.sessionId}`,
				`pid ${stack.owner.pid}`,
				...(stack.owner.worktree ? [`worktree ${stack.owner.worktree}`] : []),
				...(stack.owner.branch ? [`branch ${stack.owner.branch}`] : []),
			].join(", ")
		: "none on record";
	return `Removed ${stack.projectName}'s ${what} (${stack.root}, ${stack.runtime}): ${stack.reason}; its run: ${owner}`;
}

/**
 * Nothing of this user's is left: no live run, no recorded integration stack,
 * and no container outside the stacks this user's state does not name.
 * Another user's stacks on a shared daemon are not a reason to stay up for as
 * long as they exist.
 */
export function watchesNothing(result: SweepResult): boolean {
	if (result.liveRuns > 0 || result.pendingStacks > 0) return false;
	if (result.containers === 0) return true;
	return result.remaining.every(
		(group) => foreignStackOf(result, group) !== undefined,
	);
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
	let reportedServeFailures = new Set<string>();

	while (true) {
		const outlived = deps.outlived?.();
		if (outlived) {
			deps.log(`${outlived}; exiting`);
			return;
		}
		try {
			const serve = await deps.sweepServeEntries();
			for (const line of serve.removed) deps.log(line);
			for (const failure of serve.failures)
				if (!reportedServeFailures.has(failure)) deps.log(failure);
			reportedServeFailures = new Set(serve.failures);

			const result = await deps.sweep();
			reportedPassError = undefined;
			for (const stack of result.swept) deps.log(describeSwept(stack));

			const failures = new Map<string, string>();
			for (const failure of result.failed) {
				const key = `${failure.projectName}\t${failure.root}`;
				failures.set(key, failure.error);
				if (reportedFailures.get(key) !== failure.error)
					deps.log(`Could not remove ${failure.projectName}: ${failure.error}`);
			}
			reportedFailures = failures;

			if (watchesNothing(result)) {
				if (await deps.exitIfIdle(result)) {
					deps.log("Nothing left to watch; exiting");
					return;
				}
				deps.log("A run claimed while exiting; still watching");
			}
		} catch (error) {
			const message = getErrorMessage(error);
			if (message !== reportedPassError)
				deps.log(`Sweep failed, retrying next pass: ${message}`);
			reportedPassError = message;
		}
		await deps.sleep(deps.intervalMs);
	}
}
