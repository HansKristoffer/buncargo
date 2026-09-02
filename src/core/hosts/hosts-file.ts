import {
	chmodSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

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

export function extractManagedBlock(contents: string): {
	before: string;
	block: string | null;
	after: string;
} {
	const start = contents.indexOf(HOSTS_BLOCK_START);
	const end = contents.indexOf(HOSTS_BLOCK_END);
	if (start === -1 || end === -1 || end < start) {
		return { before: contents.replace(/\s*$/, ""), block: null, after: "" };
	}
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

export function readManagedHostnames(contents: string): string[] {
	const { block } = extractManagedBlock(contents);
	if (!block) return [];
	return block
		.split("\n")
		.flatMap((line) => {
			const match = line.match(/^(?:127\.0\.0\.1|::1)\s+(\S+)/);
			return match?.[1] ? [match[1]] : [];
		})
		.filter((hostname, index, all) => all.indexOf(hostname) === index);
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
