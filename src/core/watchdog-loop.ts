import type { SweepResult } from "../container-runtime/sweep";

export interface WatchdogLoopDeps {
	sweep: () => Promise<SweepResult>;
	sleep: (ms: number) => Promise<void>;
	log: (message: string) => void;
	intervalMs: number;
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

			if (result.containers === 0 && result.liveRuns === 0) {
				deps.log("Nothing left to watch; exiting");
				return;
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
