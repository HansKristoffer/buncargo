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
import { orphanVolumeReporter } from "../container-runtime/orphan-report";
import { sweepOrphanedContainers } from "../container-runtime/sweep";
import { checkoutDeleted } from "./checkout-presence";
import { FileLockTimeoutError, withFileLock } from "./file-lock";
import {
	sweepTailscaleServe,
	tailscaleServeDeps,
} from "./hosts/tailscale-serve";
import {
	matchesProcessIdentity,
	readCurrentProcessIdentityAsync,
} from "./process-identity";
import { writeJsonDocumentSync } from "./registry-file";
import { removalActor } from "./removal-log";
import { readAllRuns, runLivenessAsync } from "./run-registry";
import { tailnetDirectoryEnabled, watchdogParent } from "./runtime-flags";
import { getStateDir } from "./state-paths";
import { serveTailnetDirectory } from "./tailnet-directory";
import {
	getWatchdogLockFile,
	getWatchdogLogFile,
	getWatchdogPidFile,
} from "./watchdog";
import { WATCHDOG_POLL_INTERVAL_MS } from "./watchdog-constants";
import {
	claimedSincePass,
	exitUnlessClaimed,
	formatWatchdogLine,
	getWatchdogSpawnLockFile,
	runWatchdogLoop,
} from "./watchdog-loop";

const pidFile = getWatchdogPidFile();
const logFile = getWatchdogLogFile();
const ownerId = randomUUID();
const actor = removalActor("buncargo watchdog");
const reportOrphanVolumes = orphanVolumeReporter({ log });

function log(message: string): void {
	const line = formatWatchdogLine(
		{ pid: process.pid, version: actor.version },
		new Date(),
		message,
	);
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

const parent = watchdogParent();

function outlived(): string | undefined {
	if (checkoutDeleted(getStateDir())) return "The state directory is gone";
	if (parent && !matchesProcessIdentity(parent.pid, parent.identity))
		return `Process ${parent.pid}, which BUNCARGO_WATCHDOG_PARENT names, has ended`;
	return undefined;
}

function watch(owner: object): Promise<void> {
	return runWatchdogLoop({
		sweep: async () => {
			const result = await sweepOrphanedContainers({ actor });
			await reportOrphanVolumes(result.answered);
			return result;
		},
		sweepServeEntries: () => sweepTailscaleServe(tailscaleServeDeps()),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		log,
		intervalMs: WATCHDOG_POLL_INTERVAL_MS,
		outlived,
		exitIfIdle: (pass) =>
			exitUnlessClaimed({
				withSpawnLock: (operation) =>
					withFileLock(getWatchdogSpawnLockFile(), operation),
				removePidFile: cleanup,
				restorePidFile: () => writeJsonDocumentSync(pidFile, owner),
				hasLiveRuns: async () => {
					const runs = await readAllRuns();
					return claimedSincePass(pass, runs, await runLivenessAsync(runs));
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
			// What `ensureWatchdog` compares to replace a runner of older code.
			version: actor.version,
		};
		writeJsonDocumentSync(pidFile, owner);
		log(`Started from ${process.argv[1] ?? "an unknown path"}`);
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
