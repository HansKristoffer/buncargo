/**
 * The watchdog process: sweep unowned container stacks until there is
 * nothing left to watch.
 *
 * It holds no per-project state. Every tick lists the buncargo containers on
 * each runtime, compares them with the run registry, and tears down what the
 * sweep condemns. A `down` that fails is logged and retried next tick rather
 * than ending the runner, because the failure is usually the daemon
 * restarting.
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

async function watch(): Promise<void> {
	while (true) {
		// Sweep first, then wait. Starting with the wait meant a `dev` that
		// found leftovers from a crashed run left them up for a whole poll
		// interval, and a runner with nothing to do sat idle that long before
		// working it out. The run that started this claimed its containers
		// before spawning us, so the first pass cannot condemn them.
		const result = await sweepOrphanedContainers();
		for (const stack of result.swept)
			log(`Removed ${stack.projectName} (${stack.root}): ${stack.reason}`);
		for (const failure of result.failed)
			log(`Could not remove ${failure.projectName}: ${failure.error}`);
		if (result.containers === 0 && result.liveRuns === 0) {
			log("Nothing left to watch; exiting");
			return;
		}
		await new Promise((resolve) =>
			setTimeout(resolve, WATCHDOG_POLL_INTERVAL_MS),
		);
	}
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
