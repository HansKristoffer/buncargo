/**
 * The watchdog: one detached process per machine that removes container
 * stacks nobody owns any more.
 *
 * It holds no per-project state and no liveness record of its own. Runs claim
 * their containers in `~/.buncargo/runs.json` (see `environment/run-claim.ts`)
 * and the sweep compares that file with the containers each runtime reports;
 * this module only starts the process that does it on a timer.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileLockTimeoutError, withFileLock } from "./file-lock";
import { matchesProcessIdentity } from "./process-identity";
import { getStateDir, stateFilePath } from "./state-paths";
import { formatWarn } from "./style";

export function getWatchdogPidFile(): string {
	return stateFilePath("watchdog.pid");
}

export function getWatchdogLogFile(): string {
	return stateFilePath("watchdog.log");
}

/**
 * The lock a running watchdog holds for its whole life.
 *
 * Held rather than polled, so "is one already running?" is a try-acquire
 * rather than a pid file that a `kill -9` leaves lying. The kernel releases
 * it on death, including a death no handler saw.
 */
export function getWatchdogLockFile(): string {
	return `${getWatchdogPidFile()}.runner`;
}

export function getWatchdogPid(): number | null {
	try {
		const pidFile = getWatchdogPidFile();
		if (!existsSync(pidFile)) return null;
		const owner = JSON.parse(readFileSync(pidFile, "utf-8")) as {
			pid?: unknown;
			processIdentity?: unknown;
		};
		if (typeof owner.pid !== "number") return null;
		return matchesProcessIdentity(
			owner.pid,
			typeof owner.processIdentity === "string"
				? owner.processIdentity
				: undefined,
		)
			? owner.pid
			: null;
	} catch {
		return null;
	}
}

export function resolveWatchdogRunnerPath(): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDir, "watchdog-runner.js"),
		join(moduleDir, "watchdog-runner.ts"),
		join(moduleDir, "core", "watchdog-runner.js"),
		join(moduleDir, "core", "watchdog-runner.ts"),
	];
	let dir = moduleDir;
	for (let i = 0; i < 6; i++) {
		candidates.push(join(dir, "dist/core/watchdog-runner.js"));
		candidates.push(join(dir, "src/core/watchdog-runner.ts"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		"Watchdog runner not found. Rebuild buncargo so dist/core/watchdog-runner.js is emitted.",
	);
}

/**
 * Start the watchdog unless one is already running.
 *
 * Spawned through a throwaway intermediate that exits immediately, so the
 * runner is reparented to launchd before this function returns. `detached`
 * alone was not enough: it gives the runner its own session, but leaves it a
 * *child* of this process, and `pkill -P` — which is how an agent harness
 * tears a `buncargo dev` down — enumerates children by parent pid and killed
 * the watchdog along with the run it was there to outlive. That is the
 * failure this whole sweep was built for, so the watchdog must not share it.
 *
 * Started from the state directory, so it never holds a checkout open. The
 * runner's own lock is the arbiter: a duplicate spawned by a racing caller
 * cannot acquire it and exits without doing anything.
 */
export async function ensureWatchdog(
	options: { verbose?: boolean } = {},
): Promise<void> {
	const { verbose = true } = options;
	if (getWatchdogPid()) return;

	try {
		// Try-acquire: a held lock means a runner is alive, whatever the pid
		// file says. Released immediately, because the spawned runner is what
		// holds it from here on.
		await withFileLock(getWatchdogLockFile(), async () => {}, {
			timeoutMs: 0,
		});
	} catch (error) {
		if (error instanceof FileLockTimeoutError) return;
		throw error;
	}

	const logFile = getWatchdogLogFile();
	const stateDir = getStateDir();
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(logFile, "");

	// Argv through JSON rather than a shell command line: no quoting rules to
	// get wrong for a checkout path containing a space.
	const bootstrap = `const { spawn } = require("node:child_process"); spawn(${JSON.stringify(
		process.execPath,
	)}, [${JSON.stringify(resolveWatchdogRunnerPath())}], { cwd: ${JSON.stringify(
		stateDir,
	)}, detached: true, stdio: "ignore" }).unref();`;
	const proc = spawn(process.execPath, ["-e", bootstrap], {
		cwd: stateDir,
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		env: process.env,
	});

	let spawnError: Error | undefined;
	proc.on("error", (error) => {
		spawnError = error;
	});
	proc.unref();

	const startedAt = Date.now();
	while (Date.now() - startedAt < 2000) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (spawnError) throw spawnError;
		if (getWatchdogPid()) return;
	}

	if (verbose) {
		console.warn(
			formatWarn(
				`Watchdog did not start. Check ${logFile} and rebuild buncargo if dist/core/watchdog-runner.js is missing.`,
			),
		);
	}
}
