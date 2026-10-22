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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promiseTimeout } from "hanzio";
import { FileLockTimeoutError, withFileLock } from "./file-lock";
import { inOwnUserScope } from "./process/user-scope";
import {
	checkProcessIdentityAsync,
	matchesProcessIdentity,
	matchesProcessIdentityAsync,
} from "./process-identity";
import { getStateDir, stateFilePath } from "./state-paths";
import { formatWarn } from "./style";
import { buncargoVersion, compareVersions } from "./version";
import { getWatchdogSpawnLockFile } from "./watchdog-loop";

/** How long an outdated watchdog gets to exit before it is left running. */
const WATCHDOG_REPLACE_TIMEOUT_MS = 5000;

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

/** The running watchdog as its pid file records it. */
export interface WatchdogOwner {
	pid: number;
	processIdentity?: string;
	/** The runner's own buncargo version; absent from a runner before 14.0. */
	version?: string;
}

/** The watchdog the pid file names, when that process is still the one recorded. */
export async function readWatchdogOwnerAsync(): Promise<WatchdogOwner | null> {
	try {
		const raw = JSON.parse(await readFile(getWatchdogPidFile(), "utf8")) as {
			pid?: unknown;
			processIdentity?: unknown;
			version?: unknown;
		};
		if (typeof raw.pid !== "number") return null;
		const owner: WatchdogOwner = {
			pid: raw.pid,
			processIdentity:
				typeof raw.processIdentity === "string"
					? raw.processIdentity
					: undefined,
			version: typeof raw.version === "string" ? raw.version : undefined,
		};
		return (await matchesProcessIdentityAsync(owner.pid, owner.processIdentity))
			? owner
			: null;
	} catch {
		return null;
	}
}

export async function getWatchdogPidAsync(): Promise<number | null> {
	return (await readWatchdogOwnerAsync())?.pid ?? null;
}

/**
 * Whether a running watchdog is older code than this buncargo and should
 * make way for it.
 *
 * Strictly older only, so two current versions never take turns replacing
 * each other; a runner that recorded no version predates versions being
 * recorded, so it is older. A buncargo that does not know its own version
 * replaces nothing.
 */
export function isOutdatedWatchdog(
	running: Pick<WatchdogOwner, "version">,
	own: string | undefined,
): boolean {
	if (own === undefined) return false;
	if (running.version === undefined) return true;
	return compareVersions(running.version, own) < 0;
}

/**
 * Ask an outdated watchdog to exit. True when it was signalled.
 *
 * Only a pid whose recorded birth identity still matches, strictly: a pid
 * file without one, or a process that cannot be read, is left alone, as
 * `stop` leaves an app it cannot identify. Never this process: a test
 * standing in for the watchdog (`watchdog.testing.ts`) is one.
 */
async function retireOutdatedWatchdog(owner: WatchdogOwner): Promise<boolean> {
	if (owner.pid === process.pid || owner.processIdentity === undefined)
		return false;
	if (
		(await checkProcessIdentityAsync(owner.pid, owner.processIdentity)) !==
		"match"
	)
		return false;
	try {
		process.kill(owner.pid, "SIGTERM");
		return true;
	} catch {
		// Gone already, or another user's: either way not ours to replace.
		return false;
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
 * Started from the state directory, so it never holds a checkout open, and
 * under a spawn lock held until the runner is confirmed up, so two `dev` runs
 * starting together cannot each launch one.
 */
export async function ensureWatchdog(
	options: { verbose?: boolean } = {},
): Promise<void> {
	const { verbose = true } = options;
	const own = buncargoVersion();
	const running = await readWatchdogOwnerAsync();
	if (running && !isOutdatedWatchdog(running, own)) return;

	await withFileLock(getWatchdogSpawnLockFile(), async () => {
		// Re-checked under the lock: whoever held it before us may have just
		// started the watchdog this call was about to duplicate.
		const current = await readWatchdogOwnerAsync();
		if (current && !isOutdatedWatchdog(current, own)) return;
		// An older runner sweeps every checkout with old rules until it exits.
		// It exits on SIGTERM without the spawn lock this call holds, so the
		// wait for its runner lock below cannot deadlock on it.
		const replacing = current ? await retireOutdatedWatchdog(current) : false;
		if (current && !replacing) return;
		try {
			// Try-acquire the runner's own lock: a held one means a runner is
			// alive whatever the pid file says, which is how a `kill -9` that
			// left the file behind is told from a live process. Released at
			// once, because the runner we spawn is what holds it from here on.
			// When replacing, it is held until the old runner has exited.
			await withFileLock(getWatchdogLockFile(), async () => {}, {
				timeoutMs: replacing ? WATCHDOG_REPLACE_TIMEOUT_MS : 0,
			});
		} catch (error) {
			if (error instanceof FileLockTimeoutError) return;
			throw error;
		}

		const logFile = getWatchdogLogFile();
		const stateDir = getStateDir();
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(logFile, "");

		// Argv through JSON rather than a shell command line: no quoting rules
		// to get wrong for a checkout path containing a space.
		const bootstrap = `const { spawn } = require("node:child_process"); spawn(${JSON.stringify(
			process.execPath,
		)}, [${JSON.stringify(resolveWatchdogRunnerPath())}], { cwd: ${JSON.stringify(
			stateDir,
		)}, detached: true, stdio: "ignore" }).unref();`;
		// Its own scope on Linux, so restarting the service an agent runs in
		// does not take the watchdog down with that service's cgroup.
		const [command, ...args] = inOwnUserScope(
			[process.execPath, "-e", bootstrap],
			"buncargo watchdog",
		);
		const proc = spawn(command as string, args, {
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

		// Held until the runner is confirmed up, so a concurrent caller cannot
		// spawn a second one into the gap.
		const startedAt = Date.now();
		while (Date.now() - startedAt < 2000) {
			await promiseTimeout(100);
			if (spawnError) throw spawnError;
			if (await getWatchdogPidAsync()) return;
		}

		if (verbose) {
			console.warn(
				formatWarn(
					`Watchdog did not start. Check ${logFile} and rebuild buncargo if dist/core/watchdog-runner.js is missing.`,
				),
			);
		}
	});
}
