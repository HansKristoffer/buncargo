import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isProcessAlive } from "./process/lifecycle";
import { recordStartupMetric } from "./startup-metrics";

/**
 * Marks an identity written in the current, environment-independent format.
 *
 * Identities are recorded by one process and checked by another: a dev run
 * and the watchdog, a run and the menu bar's `stop`, a worker's owner and the
 * next run in the checkout. On macOS the birth time comes from `ps`, whose
 * output follows the caller's locale and time zone, so two processes read the
 * same pid differently: a run started from a Danish-locale terminal and a
 * watchdog started from a `C.UTF-8` agent shell disagreed, and the watchdog
 * read the live run as dead. `ps` is always asked in the C locale and UTC.
 */
const IDENTITY_PREFIX = "v2:";
let bootId: string | undefined;

function hashBirth(birth: string): string {
	return createHash("sha256").update(birth).digest("hex");
}

/**
 * Birth on Linux: boot id and start tick from `/proc`, a file read rather
 * than a fork, and already the same in every environment.
 */
function linuxBirth(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (!start) return undefined;
		bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return `${bootId}:${start}`;
	} catch {
		// The pid exited, or `/proc` is unreadable: cannot inspect.
		return undefined;
	}
}

/**
 * Birth on macOS: `ps -o lstart` for many pids in one fork.
 *
 * Reads stdout whatever the exit status: `ps` exits non-zero when a requested
 * pid is missing, yet still prints the ones it found.
 */
export function parsePsBirths(stdout: string): Map<number, string> {
	const births = new Map<number, string>();
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		const boundary = line.indexOf(" ");
		if (boundary <= 0) continue;
		const pid = Number.parseInt(line.slice(0, boundary), 10);
		const birth = line.slice(boundary + 1).trim();
		if (Number.isInteger(pid) && birth) births.set(pid, birth);
	}
	return births;
}

function psBirths(pids: readonly number[]): Map<number, string> {
	try {
		recordStartupMetric("subprocesses");
		recordStartupMetric("processIdentityReads");
		const { stdout = "" } = spawnSync(
			"ps",
			["-o", "pid=,lstart=", "-p", pids.join(",")],
			{
				encoding: "utf8",
				timeout: 1000,
				env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		return parsePsBirths(stdout);
	} catch {
		// A `ps` that cannot run reads as "cannot inspect". Liveness keeps the
		// run on that answer; signalling refuses on it.
	}
	return new Map();
}

// Pid 0 and 1 are never a run's process, and `ps` refuses the whole batch when
// one of its pids is not a pid at all.
function isInspectablePid(pid: number): boolean {
	return Number.isInteger(pid) && pid > 1;
}

export function isLivePid(pid: number): boolean {
	return isInspectablePid(pid) && isProcessAlive(pid);
}

export function wantedPids(pids: readonly number[]): number[] {
	return [...new Set(pids)].filter(isInspectablePid);
}

export function encodeBirths(births: Map<number, string>): Map<number, string> {
	return new Map(
		[...births].map(([pid, birth]) => [
			pid,
			`${IDENTITY_PREFIX}${hashBirth(birth)}`,
		]),
	);
}

/**
 * Birth identity for many pids at once, in the current format.
 *
 * The watchdog asks this of every owner on every pass, and the run registry
 * of every entry on every read, so it is one `ps` rather than one per pid.
 * Pids absent from the result are not running, or could not be read.
 * Never throws.
 */
export function readProcessIdentities(
	pids: readonly number[],
): Map<number, string> {
	const wanted = wantedPids(pids);
	if (wanted.length === 0) return new Map();

	const births =
		process.platform === "linux"
			? new Map(
					wanted.flatMap((pid) => {
						const birth = linuxBirth(pid);
						return birth === undefined ? [] : [[pid, birth] as const];
					}),
				)
			: psBirths(wanted);
	return encodeBirths(births);
}

/** Identities of live pids, as {@link readProcessIdentities} returns them. */
export type ProcessIdentityReader = (
	pids: readonly number[],
) => Map<number, string>;

/**
 * Identity reads remembered per pid, for a long-lived reader that asks about
 * the same owners again and again: `getEnvVar` inside a `vite.config.ts` is
 * read several times per load and on every reload, and on macOS each read is
 * a `ps`.
 *
 * Liveness is still checked on every call, and a pid seen dead is forgotten,
 * so only a pid not seen before is read. What it gives up: a pid that dies
 * and is reused between two calls keeps the identity first read. For liveness
 * readers only; never for deciding to signal a pid.
 */
export function createProcessIdentityCache(deps: {
	read: ProcessIdentityReader;
	isAlive: (pid: number) => boolean;
}): ProcessIdentityReader {
	const known = new Map<number, string>();
	return (pids) => {
		const identities = new Map<number, string>();
		const unseen: number[] = [];

		for (const pid of wantedPids(pids)) {
			if (!deps.isAlive(pid)) {
				known.delete(pid);
				continue;
			}

			const identity = known.get(pid);
			if (identity === undefined) unseen.push(pid);
			else identities.set(pid, identity);
		}

		if (unseen.length === 0) return identities;

		for (const [pid, identity] of deps.read(unseen)) {
			known.set(pid, identity);
			identities.set(pid, identity);
		}
		return identities;
	};
}

/**
 * {@link readProcessIdentities} through this process's one
 * {@link createProcessIdentityCache}: what the synchronous liveness readers
 * that run inside users' configs use.
 */
export const readProcessIdentitiesCached = createProcessIdentityCache({
	read: readProcessIdentities,
	isAlive: isProcessAlive,
});
