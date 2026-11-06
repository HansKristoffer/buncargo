import {
	chmodSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { PrivilegedRunner } from "./privileged";

export const HOSTS_BLOCK_START = "# buncargo-start";
export const HOSTS_BLOCK_END = "# buncargo-end";
export const DEFAULT_HOSTS_FILE = "/etc/hosts";

export function buildHostsBlock(hostnames: string[]): string {
	const unique = [...new Set(hostnames)].sort();
	const lines = unique.flatMap((hostname) => [
		`127.0.0.1 ${hostname}`,
		`::1 ${hostname}`,
	]);
	return [HOSTS_BLOCK_START, ...lines, HOSTS_BLOCK_END].join("\n");
}

/**
 * Where the managed block is: the first end marker, and the start marker
 * closest before it.
 *
 * A start whose end was lost (a hand edit, a torn write) is not part of any
 * block. Pairing the first start with the first end instead reached from that
 * orphan to the end of the block appended after it, and deleted every line
 * the user had between the two.
 */
function findManagedBlock(
	contents: string,
): { start: number; end: number } | undefined {
	let start = contents.indexOf(HOSTS_BLOCK_START);
	while (start !== -1) {
		const end = contents.indexOf(HOSTS_BLOCK_END, start);
		if (end === -1) return undefined;
		const next = contents.indexOf(
			HOSTS_BLOCK_START,
			start + HOSTS_BLOCK_START.length,
		);
		const orphan = next !== -1 && next < end;
		if (!orphan) return { start, end };
		start = next;
	}
	return undefined;
}

export function extractManagedBlock(contents: string): {
	before: string;
	block: string | null;
	after: string;
} {
	const found = findManagedBlock(contents);
	if (!found) {
		return { before: contents.replace(/\s*$/, ""), block: null, after: "" };
	}
	const { start, end } = found;
	return {
		before: contents.slice(0, start).replace(/\s*$/, ""),
		block: contents.slice(start, end + HOSTS_BLOCK_END.length),
		after: contents.slice(end + HOSTS_BLOCK_END.length).replace(/^\s*/, ""),
	};
}

export function applyHostsBlock(contents: string, hostnames: string[]): string {
	const { before, after } = extractManagedBlock(contents);
	if (hostnames.length === 0) {
		return (
			[before, after].filter(Boolean).join("\n") + (before || after ? "\n" : "")
		);
	}
	const parts = [before, buildHostsBlock(hostnames), after].filter(Boolean);
	return `${parts.join("\n\n")}\n`;
}

/** Mode to fall back to when the current file cannot be stat'd. */
const HOSTS_FILE_MODE = 0o644;

/**
 * Replace the hosts file through a temp file and a rename.
 *
 * `writeFileSync` truncates in place, and every name resolution on the machine
 * reads this file — including the `localhost` entry the system itself depends
 * on. A resolver landing inside that window sees a truncated file and fails to
 * resolve names that are plainly there. A rename within `/etc` is atomic, so a
 * reader sees either the old file or the new one.
 *
 * Falls back to a direct write when the rename cannot be done (a hosts file
 * that is a symlink onto another filesystem, say): a torn write is bad, but
 * never updating the file at all takes every named URL down.
 */
function writeHostsFileAtomically(filePath: string, contents: string): void {
	const mode = (() => {
		try {
			return statSync(filePath).mode & 0o777;
		} catch {
			return HOSTS_FILE_MODE;
		}
	})();

	const temp = join(
		dirname(filePath),
		`.buncargo-hosts.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(temp, contents, { mode });
		chmodSync(temp, mode);
		renameSync(temp, filePath);
	} catch (error) {
		rmSync(temp, { force: true });
		try {
			writeFileSync(filePath, contents);
		} catch {
			// Report the original failure: it is the one that explains why.
			throw error;
		}
	}
}

export function syncHostsFile(
	hostnames: string[],
	filePath = DEFAULT_HOSTS_FILE,
): void {
	const current = readFileSync(filePath, "utf-8");
	const next = applyHostsBlock(current, hostnames);
	if (next !== current) {
		writeHostsFileAtomically(filePath, next);
	}
}

export function cleanHostsFile(filePath = DEFAULT_HOSTS_FILE): void {
	syncHostsFile([], filePath);
}

function isPermissionError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "EACCES" || code === "EPERM";
}

/**
 * Remove the managed block, through `sudo` when this user cannot write it.
 *
 * The root daemon wrote the block, and `hosts uninstall` has stopped it by
 * the time it gets here, so a plain user write fails with EACCES. Swallowed,
 * that left every hostname pointing at a proxy that no longer exists.
 */
export function cleanHostsFileAsRoot(
	runner: Pick<PrivilegedRunner, "writeFile">,
	filePath = DEFAULT_HOSTS_FILE,
): void {
	try {
		cleanHostsFile(filePath);
		return;
	} catch (error) {
		if (!isPermissionError(error)) throw error;
	}
	const current = readFileSync(filePath, "utf-8");
	const next = applyHostsBlock(current, []);
	if (next !== current) runner.writeFile(filePath, next);
}
