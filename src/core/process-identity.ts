import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isProcessAlive } from "./process/lifecycle";

/**
 * Marks an identity written in the current, environment-independent format.
 *
 * Identities are recorded by one process and checked by another — a dev run
 * and the watchdog, a run and the menu bar's `stop`, a worker's owner and the
 * next run in the checkout. On macOS the birth time comes from `ps`, whose
 * output follows the caller's locale and time zone, so two processes read the
 * same pid differently: a run started from a Danish-locale terminal and a
 * watchdog started from a `C.UTF-8` agent shell disagreed, and the watchdog
 * read the live run as dead. `ps` is now always asked in the C locale and UTC.
 *
 * An identity without the prefix was written by an older version, in
 * whatever environment that version ran in. See {@link matchesProcessIdentity}
 * and {@link processIdentityMatcher} for what each makes of one.
 */
const IDENTITY_PREFIX = "v2:";

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
		const bootId = readFileSync(
			"/proc/sys/kernel/random/boot_id",
			"utf8",
		).trim();
		return `${bootId}:${start}`;
	} catch {
		return undefined;
	}
}

/**
 * Birth on macOS: `ps -o lstart` for many pids in one fork.
 *
 * Reads stdout whatever the exit status: `ps` exits non-zero when a requested
 * pid is missing, yet still prints the ones it found. `env` is the locale and
 * time zone to ask in; the current format always passes C and UTC.
 */
function psBirths(
	pids: readonly number[],
	env: NodeJS.ProcessEnv,
): Map<number, string> {
	const births = new Map<number, string>();
	try {
		const { stdout = "" } = spawnSync(
			"ps",
			["-o", "pid=,lstart=", "-p", pids.join(",")],
			{
				encoding: "utf8",
				timeout: 1000,
				env,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		for (const raw of stdout.split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			// `pid=,lstart=` prints the pid right-aligned, then the date. The
			// date itself contains spaces, so split once and keep the rest.
			const boundary = line.indexOf(" ");
			if (boundary <= 0) continue;
			const pid = Number.parseInt(line.slice(0, boundary), 10);
			const birth = line.slice(boundary + 1).trim();
			if (Number.isInteger(pid) && birth) births.set(pid, birth);
		}
	} catch {
		// A `ps` that cannot run reads as "cannot inspect". Liveness keeps the
		// run on that answer; signalling refuses on it.
	}
	return births;
}

const STABLE_PS_ENV = { ...process.env, LC_ALL: "C", TZ: "UTC" };

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
	const identities = new Map<number, string>();
	const wanted = [...new Set(pids)].filter(
		(pid) => Number.isInteger(pid) && pid > 1,
	);
	if (wanted.length === 0) return identities;

	const births =
		process.platform === "linux"
			? new Map(
					wanted.flatMap((pid) => {
						const birth = linuxBirth(pid);
						return birth === undefined ? [] : [[pid, birth] as const];
					}),
				)
			: psBirths(wanted, STABLE_PS_ENV);
	for (const [pid, birth] of births)
		identities.set(pid, `${IDENTITY_PREFIX}${hashBirth(birth)}`);
	return identities;
}

/** Process birth identity survives exec but changes when an OS reuses a pid. */
export function readProcessIdentity(pid: number): string | undefined {
	return readProcessIdentities([pid]).get(pid);
}

/**
 * The identity an older version would have recorded for this pid.
 *
 * Read in this process's own environment, the way those versions read it, so
 * a record they wrote compares exactly as it did before. It only ever matches
 * when the environments agree, which was already the limit of that format.
 */
function readLegacyIdentity(pid: number): string | undefined {
	const birth =
		process.platform === "linux"
			? linuxBirth(pid)
			: psBirths([pid], process.env).get(pid);
	return birth === undefined ? undefined : hashBirth(birth);
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
	return identity.startsWith(IDENTITY_PREFIX)
		? readProcessIdentity(pid) === identity
		: readLegacyIdentity(pid) === identity;
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
	entries: readonly { pid: number; processIdentity?: string }[],
): (pid: number, identity?: string) => boolean {
	// Only live pids are worth an identity, and asking `ps` about one that is
	// not a pid at all makes it refuse the whole batch.
	const alive = new Set(
		entries
			.map((entry) => entry.pid)
			.filter((pid) => Number.isInteger(pid) && pid > 1 && isProcessAlive(pid)),
	);
	const identities = readProcessIdentities([...alive]);
	return (pid, identity) => {
		if (!alive.has(pid)) return false;
		// Recorded by an older version in an environment we cannot reproduce:
		// it cannot be compared, so it cannot condemn a live process either.
		if (identity === undefined || !identity.startsWith(IDENTITY_PREFIX))
			return true;
		const actual = identities.get(pid);
		// Unreadable is not a mismatch. This answers "is the run still going?",
		// and reading a live run as dead because `ps` was slow would let the
		// sweep tear down containers somebody is using. A reused pid has an
		// identity, a different one, and still reads as gone.
		return actual === undefined || actual === identity;
	};
}
