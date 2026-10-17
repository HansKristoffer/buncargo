/**
 * The watchdog process: sweep unowned container stacks until there is
 * nothing left to watch.
 *
 * It holds no per-project state. Every tick lists the buncargo containers on
 * each runtime, compares them with the run registry, and tears down what the
 * sweep condemns. The loop itself lives in `watchdog-loop.ts`, where a pass
 * that fails for any reason is logged and retried rather than ending the
 * runner; this file is only the process around it.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
import { sweepOrphanedContainers } from "../container-runtime/sweep";
import { FileLockTimeoutError, withFileLock } from "./file-lock";
import { readCurrentProcessIdentityAsync } from "./process-identity";
import { writeJsonDocumentSync } from "./registry-file";
import { readAllRuns, runLivenessAsync } from "./run-registry";
import { tailnetDirectoryEnabled } from "./runtime-flags";
import { serveTailnetDirectory } from "./tailnet-directory";
import {
	getWatchdogLockFile,
	getWatchdogLogFile,
	getWatchdogPidFile,
} from "./watchdog";
import { WATCHDOG_POLL_INTERVAL_MS } from "./watchdog-constants";
import {
	exitUnlessClaimed,
	getWatchdogSpawnLockFile,
	runWatchdogLoop,
} from "./watchdog-loop";

const pidFile = getWatchdogPidFile();
const logFile = getWatchdogLogFile();
const ownerId = randomUUID();

function log(message: string): void {
	const line = `[watchdog] ${new Date().toISOString()} ${message}`;
	console.log(line);
	try {
		appendFileSync(logFile, `${line}\n`);
	} catch {
		// ignore log write failures
	}
}

function cleanup(): void {
	try {
		const owner = JSON.parse(readFileSync(pidFile, "utf8"));
		if (owner.ownerId === ownerId && owner.pid === process.pid)
			unlinkSync(pidFile);
	} catch {
		/* Missing or replaced: not ours to remove. */
	}
}

process.on("SIGTERM", () => {
	cleanup();
	process.exit(0);
});

process.on("SIGINT", () => {
	cleanup();
	process.exit(0);
});

function watch(owner: object): Promise<void> {
	return runWatchdogLoop({
		sweep: () => sweepOrphanedContainers(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log,
		intervalMs: WATCHDOG_POLL_INTERVAL_MS,
		exitIfIdle: () =>
			exitUnlessClaimed({
				withSpawnLock: (operation) =>
					withFileLock(getWatchdogSpawnLockFile(), operation),
				removePidFile: cleanup,
				restorePidFile: () => writeJsonDocumentSync(pidFile, owner),
				hasLiveRuns: async () => {
					const runs = await readAllRuns();
					return runs.some(await runLivenessAsync(runs));
				},
			}),
	});
}

// The lock held for the runner's lifetime is the startup claim, and the
// kernel releases it after a crash; a PID file alone cannot provide either.
withFileLock(
	getWatchdogLockFile(),
	async () => {
		const owner = {
			pid: process.pid,
			ownerId,
			processIdentity: await readCurrentProcessIdentityAsync(),
		};
		writeJsonDocumentSync(pidFile, owner);
		log(`Started (PID: ${process.pid})`);
		const stopDirectory = tailnetDirectoryEnabled()
			? serveTailnetDirectory({ log, intervalMs: WATCHDOG_POLL_INTERVAL_MS })
			: () => {};
		try {
			await watch(owner);
		} finally {
			stopDirectory();
			cleanup();
		}
	},
	{ timeoutMs: 0 },
).then(
	// The loop left holding the spawn lock, and only exiting releases it,
	// after the runner lock above.
	() => process.exit(0),
	(error: unknown) => {
		// Losing the race to another runner is the expected outcome of two `dev`
		// runs starting at once, not a failure worth a line in the log.
		if (error instanceof FileLockTimeoutError) return;
		log(
			`Watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		cleanup();
		process.exitCode = 1;
	},
);
