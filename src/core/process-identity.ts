import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execAsync } from "./process/exec";
import { isProcessAlive } from "./process/lifecycle";
import { recordStartupMetric } from "./startup-metrics";

/**
 * Marks an identity written in the current, environment-independent format.
 *
 * Identities are recorded by one process and checked by another — a dev run
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
		return undefined;
	}
}

/**
 * Birth on macOS: `ps -o lstart` for many pids in one fork.
 *
 * Reads stdout whatever the exit status: `ps` exits non-zero when a requested
 * pid is missing, yet still prints the ones it found.
 */
function parsePsBirths(stdout: string): Map<number, string> {
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

const STABLE_PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

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
				env: STABLE_PS_ENV,
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

function wantedPids(pids: readonly number[]): number[] {
	return [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 1);
}

function encodeBirths(births: Map<number, string>): Map<number, string> {
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

async function linuxBirthAsync(
	pid: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, {
			encoding: "utf8",
			signal,
		});
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (!start) return undefined;
		bootId ??= (
			await readFile("/proc/sys/kernel/random/boot_id", {
				encoding: "utf8",
				signal,
			})
		).trim();
		return `${bootId}:${start}`;
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

async function psBirthsAsync(
	pids: readonly number[],
	signal?: AbortSignal,
): Promise<Map<number, string>> {
	recordStartupMetric("processIdentityReads");
	const result = await execAsync(
		["ps", "-o", "pid=,lstart=", "-p", pids.join(",")],
		process.cwd(),
		{},
		{
			env: { LC_ALL: "C", TZ: "UTC" },
			timeoutMs: 1000,
			killGraceMs: 0,
			maxBufferBytes: 1024 * 1024,
			throwOnError: false,
			signal,
		},
	);
	signal?.throwIfAborted();
	return parsePsBirths(result.stdout);
}

/** Async counterpart: inspection failures are unknown; cancellation still rejects. */
export async function readProcessIdentitiesAsync(
	pids: readonly number[],
	signal?: AbortSignal,
): Promise<Map<number, string>> {
	signal?.throwIfAborted();
	const wanted = wantedPids(pids);
	if (!wanted.length) return new Map();
	const births =
		process.platform === "linux"
			? new Map(
					(
						await Promise.all(
							wanted.map(async (pid) => {
								const birth = await linuxBirthAsync(pid, signal);
								return birth === undefined ? [] : [[pid, birth] as const];
							}),
						)
					).flat(),
				)
			: await psBirthsAsync(wanted, signal);
	signal?.throwIfAborted();
	return encodeBirths(births);
}

export async function readProcessIdentityAsync(
	pid: number,
	signal?: AbortSignal,
): Promise<string | undefined> {
	return (await readProcessIdentitiesAsync([pid], signal)).get(pid);
}

/** Process birth identity survives exec but changes when an OS reuses a pid. */
export function readProcessIdentity(pid: number): string | undefined {
	return readProcessIdentities([pid]).get(pid);
}

let currentIdentity: string | undefined;

/** The current process cannot change birth identity during its lifetime. */
export function readCurrentProcessIdentity(): string | undefined {
	currentIdentity ??= readProcessIdentity(process.pid);
	return currentIdentity;
}

export async function readCurrentProcessIdentityAsync(
	signal?: AbortSignal,
): Promise<string | undefined> {
	signal?.throwIfAborted();
	currentIdentity ??= await readProcessIdentityAsync(process.pid, signal);
	return currentIdentity;
}

/**
 * Whether `pid` is still the process that was recorded, strictly.
 *
 * For deciding to act on a pid — signalling it, or treating it as the one
 * owner of something. "Cannot tell" has to mean "no" here.
 */
export function matchesProcessIdentity(
	pid: number,
	identity?: string,
): boolean {
	if (!Number.isInteger(pid) || pid <= 1 || !isProcessAlive(pid)) return false;
	if (identity === undefined) return true;
	return readProcessIdentity(pid) === identity;
}

export async function matchesProcessIdentityAsync(
	pid: number,
	identity?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	signal?.throwIfAborted();
	if (!Number.isInteger(pid) || pid <= 1 || !isProcessAlive(pid)) return false;
	if (identity === undefined) return true;
	return (await readProcessIdentityAsync(pid, signal)) === identity;
}

type IdentityEntry = { pid: number; processIdentity?: string };
function livePids(entries: readonly IdentityEntry[]): Set<number> {
	return new Set(
		entries
			.map((entry) => entry.pid)
			.filter((pid) => Number.isInteger(pid) && pid > 1 && isProcessAlive(pid)),
	);
}

function identityMatcher(
	alive: Set<number>,
	identities: Map<number, string>,
): (pid: number, identity?: string) => boolean {
	return (pid, identity) => {
		if (!alive.has(pid)) return false;
		if (identity === undefined) return true;
		const actual = identities.get(pid);
		// Unknown inspection preserves liveness; strict signalling never uses this.
		return actual === undefined || actual === identity;
	};
}

/**
 * Whether each process is still the one that was recorded, for a whole list
 * with one `ps` between them.
 *
 * For liveness, and deliberately more forgiving than
 * {@link matchesProcessIdentity}: that one guards signalling a pid, where
 * "cannot tell" has to mean "do not", while this one guards tearing down a
 * run's containers, where it has to mean "leave them".
 *
 * Returns a predicate rather than a filtered list so callers keep whatever
 * shape their entries have.
 */
export function processIdentityMatcher(
	entries: readonly IdentityEntry[],
): (pid: number, identity?: string) => boolean {
	// Only live pids are worth an identity, and asking `ps` about one that is
	// not a pid at all makes it refuse the whole batch.
	const alive = livePids(entries);
	const identities = readProcessIdentities([...alive]);
	return identityMatcher(alive, identities);
}

/** Same forgiving liveness policy, without blocking the event loop. */
export async function processIdentityMatcherAsync(
	entries: readonly IdentityEntry[],
	signal?: AbortSignal,
): Promise<(pid: number, identity?: string) => boolean> {
	const alive = livePids(entries);
	return identityMatcher(
		alive,
		await readProcessIdentitiesAsync([...alive], signal),
	);
}
