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
import { readProcessIdentity } from "./process-identity";
import { writeJsonDocumentSync } from "./registry-file";
import {
	getWatchdogLockFile,
	getWatchdogLogFile,
	getWatchdogPidFile,
} from "./watchdog";
import { WATCHDOG_POLL_INTERVAL_MS } from "./watchdog-constants";
import { runWatchdogLoop } from "./watchdog-loop";

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

function watch(): Promise<void> {
	return runWatchdogLoop({
		sweep: () => sweepOrphanedContainers(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log,
		intervalMs: WATCHDOG_POLL_INTERVAL_MS,
	});
}

// The lock held for the runner's lifetime is the startup claim, and the
// kernel releases it after a crash; a PID file alone cannot provide either.
withFileLock(
	getWatchdogLockFile(),
	async () => {
		writeJsonDocumentSync(pidFile, {
			pid: process.pid,
			ownerId,
			processIdentity: readProcessIdentity(process.pid),
		});
		log(`Started (PID: ${process.pid})`);
		try {
			await watch();
		} finally {
			cleanup();
		}
	},
	{ timeoutMs: 0 },
).catch((error: unknown) => {
	// Losing the race to another runner is the expected outcome of two `dev`
	// runs starting at once, not a failure worth a line in the log.
	if (error instanceof FileLockTimeoutError) return;
	log(
		`Watchdog failed: ${error instanceof Error ? error.message : String(error)}`,
	);
	cleanup();
	process.exitCode = 1;
});
