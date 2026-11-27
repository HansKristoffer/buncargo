import { readFile } from "node:fs/promises";
import { execAsync } from "./process/exec";
import { isProcessAlive } from "./process/lifecycle";
import {
	createProcessIdentityCache,
	encodeBirths,
	isLivePid,
	type ProcessIdentityReader,
	parsePsBirths,
	readProcessIdentities,
	readProcessIdentitiesCached,
	wantedPids,
} from "./process-identity-sync";
import { recordStartupMetric } from "./startup-metrics";

export {
	createProcessIdentityCache,
	type ProcessIdentityReader,
	readProcessIdentities,
	readProcessIdentitiesCached,
};

let bootId: string | undefined;

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
	if (wanted.length === 0) return new Map();

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
 * For deciding to act on a pid, such as signalling it or treating it as the
 * one owner of something. "Cannot tell" has to mean "no" here.
 */
export function matchesProcessIdentity(
	pid: number,
	identity?: string,
): boolean {
	if (!isLivePid(pid)) return false;
	if (identity === undefined) return true;
	return readProcessIdentity(pid) === identity;
}

export async function matchesProcessIdentityAsync(
	pid: number,
	identity?: string,
	signal?: AbortSignal,
): Promise<boolean> {
	return (await checkProcessIdentityAsync(pid, identity, signal)) === "match";
}

/**
 * `unreadable`: the pid runs, but its birth could not be read (`ps` failed or
 * timed out). Not a mismatch: a caller about to report a process stopped must
 * not read it as "already gone".
 */
export type ProcessIdentityCheck = "match" | "mismatch" | "unreadable";

function compareIdentity(
	pid: number,
	expected: string,
	actual: string | undefined,
): ProcessIdentityCheck {
	if (actual === expected) return "match";
	if (actual !== undefined) return "mismatch";

	// Linux reads nothing for a pid that exited during the read.
	return isProcessAlive(pid) ? "unreadable" : "mismatch";
}

/** {@link matchesProcessIdentityAsync}, telling "cannot tell" apart from "no". */
export async function checkProcessIdentityAsync(
	pid: number,
	identity?: string,
	signal?: AbortSignal,
): Promise<ProcessIdentityCheck> {
	signal?.throwIfAborted();
	if (!isLivePid(pid)) return "mismatch";
	if (identity === undefined) return "match";

	const actual = await readProcessIdentityAsync(pid, signal);
	return compareIdentity(pid, identity, actual);
}

/**
 * {@link checkProcessIdentityAsync} for a whole list, with one `ps` between
 * them, in the list's order. The caller decides what `unreadable` means for
 * it, in plain sight.
 */
export async function checkProcessIdentitiesAsync(
	entries: readonly { pid: number; identity?: string }[],
	signal?: AbortSignal,
): Promise<ProcessIdentityCheck[]> {
	signal?.throwIfAborted();
	const asked = entries.filter(
		(entry) => entry.identity !== undefined && isLivePid(entry.pid),
	);
	const actual = await readProcessIdentitiesAsync(
		asked.map((entry) => entry.pid),
		signal,
	);

	return entries.map(({ pid, identity }): ProcessIdentityCheck => {
		if (!isLivePid(pid)) return "mismatch";
		if (identity === undefined) return "match";

		return compareIdentity(pid, identity, actual.get(pid));
	});
}

type IdentityEntry = { pid: number; processIdentity?: string };

function livePids(entries: readonly IdentityEntry[]): Set<number> {
	return new Set(entries.map((entry) => entry.pid).filter(isLivePid));
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
export async function processIdentityMatcherAsync(
	entries: readonly IdentityEntry[],
	signal?: AbortSignal,
): Promise<(pid: number, identity?: string) => boolean> {
	// Only live pids need a birth lookup, and asking `ps` about one that is
	// not a pid at all makes it refuse the batch.
	const alive = livePids(entries);
	return identityMatcher(
		alive,
		alive.size > 0
			? await readProcessIdentitiesAsync([...alive], signal)
			: new Map(),
	);
}
