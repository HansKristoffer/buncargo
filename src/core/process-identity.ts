import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isProcessAlive } from "./process/lifecycle";

function hashBirth(birth: string): string {
	return createHash("sha256").update(birth).digest("hex");
}

/** Linux reads birth from `/proc`, which is a file read rather than a fork. */
function linuxIdentity(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		if (!start) return undefined;
		const bootId = readFileSync(
			"/proc/sys/kernel/random/boot_id",
			"utf8",
		).trim();
		return hashBirth(`${bootId}:${start}`);
	} catch {
		return undefined;
	}
}

/**
 * Birth identity for many pids in one `ps`.
 *
 * The watchdog asks this of every owner on every tick, and the run registry
 * asks it of every entry on every read, so one fork per pid was most of what
 * an idle machine spent on buncargo. macOS has no `/proc`, so the fork cannot
 * go away entirely — but it can be one fork instead of N.
 *
 * Pids absent from the result are not running. Never throws.
 */
export function readProcessIdentities(
	pids: readonly number[],
): Map<number, string> {
	const identities = new Map<number, string>();
	const wanted = [...new Set(pids)].filter(
		(pid) => Number.isInteger(pid) && pid > 1,
	);
	if (wanted.length === 0) return identities;

	if (process.platform === "linux") {
		for (const pid of wanted) {
			const identity = linuxIdentity(pid);
			if (identity !== undefined) identities.set(pid, identity);
		}
		return identities;
	}

	try {
		const output = execFileSync(
			"ps",
			["-o", "pid=,lstart=", "-p", wanted.join(",")],
			{ encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] },
		);
		for (const raw of output.split("\n")) {
			const line = raw.trim();
			if (!line) continue;
			// `pid=,lstart=` prints the pid right-aligned, then the date. The
			// date itself contains spaces, so split once and keep the rest.
			const boundary = line.indexOf(" ");
			if (boundary <= 0) continue;
			const pid = Number.parseInt(line.slice(0, boundary), 10);
			const birth = line.slice(boundary + 1).trim();
			// Hash the same string the single-pid form hashed, so an identity
			// written by either one verifies against the other.
			if (Number.isInteger(pid) && birth) identities.set(pid, hashBirth(birth));
		}
	} catch {
		// A `ps` that cannot run reads as "cannot inspect", which every caller
		// already treats as "do not condemn", never as "the process is gone".
	}
	return identities;
}

/** Process birth identity survives exec but changes when an OS reuses a pid. */
export function readProcessIdentity(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 1) return undefined;
	if (process.platform === "linux") return linuxIdentity(pid);
	return readProcessIdentities([pid]).get(pid);
}

export function matchesProcessIdentity(
	pid: number,
	identity?: string,
): boolean {
	return (
		Number.isInteger(pid) &&
		pid > 1 &&
		isProcessAlive(pid) &&
		(identity === undefined || readProcessIdentity(pid) === identity)
	);
}

/**
 * {@link matchesProcessIdentity} for a whole list, with one `ps` between them.
 *
 * Returns a predicate rather than a filtered list so callers keep whatever
 * shape their entries have.
 */
export function processIdentityMatcher(
	entries: readonly { pid: number; processIdentity?: string }[],
): (pid: number, identity?: string) => boolean {
	const identities = readProcessIdentities(entries.map((entry) => entry.pid));
	return (pid, identity) =>
		Number.isInteger(pid) &&
		pid > 1 &&
		isProcessAlive(pid) &&
		(identity === undefined || identities.get(pid) === identity);
}
