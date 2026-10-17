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
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { sweepOrphanedContainers } from "../container-runtime/sweep";
import { FileLockTimeoutError, withFileLock } from "./file-lock";
import { currentOsUser } from "./os-user";
import { readCurrentProcessIdentityAsync } from "./process-identity";
import { writeJsonDocumentSync } from "./registry-file";
import { tailnetDirectoryEnabled } from "./runtime-flags";
import { serveTailnetDirectory } from "./tailnet-directory";
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

/** The buncargo install this runner was started from, and its version. */
function installIdentity(): { checkout: string; version: string } {
	let dir = import.meta.dir;
	while (true) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const pkg = JSON.parse(readFileSync(manifest, "utf8"));
				if (pkg.name === "buncargo")
					return { checkout: dir, version: String(pkg.version) };
			} catch {
				// Not readable: keep walking up.
			}
		}
		const parent = dirname(dir);
		if (parent === dir)
			return { checkout: import.meta.dir, version: "unknown" };
		dir = parent;
	}
}

function watchdogIdentity(): string {
	const { checkout, version } = installIdentity();
	return `watchdog v${version} pid ${process.pid} user ${currentOsUser() || "unknown"} checkout ${checkout}`;
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
		identity: watchdogIdentity(),
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
			processIdentity: await readCurrentProcessIdentityAsync(),
		});
		log(`Started (PID: ${process.pid})`);
		const stopDirectory = tailnetDirectoryEnabled()
			? serveTailnetDirectory({ log, intervalMs: WATCHDOG_POLL_INTERVAL_MS })
			: () => {};
		try {
			await watch();
		} finally {
			stopDirectory();
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
