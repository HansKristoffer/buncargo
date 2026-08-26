import { readFileSync, writeFileSync } from "node:fs";

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

export function syncHostsFile(
	hostnames: string[],
	filePath = DEFAULT_HOSTS_FILE,
): void {
	const current = readFileSync(filePath, "utf-8");
	const next = applyHostsBlock(current, hostnames);
	if (next !== current) {
		writeFileSync(filePath, next);
	}
}

export function cleanHostsFile(filePath = DEFAULT_HOSTS_FILE): void {
	syncHostsFile([], filePath);
}
