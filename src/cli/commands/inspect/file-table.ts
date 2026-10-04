import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { platform } from "node:os";

/**
 * How full the machine's open-file table is, and who fills it.
 *
 * ENFILE breaks unrelated tools (typecheckers, simulators, browsers), and the
 * cause is usually a long-lived process in another checkout - `bun --watch`
 * kept thousands of descriptors per reload - so no single run can see it.
 * `doctor` is where someone looks when things fail for no reason.
 */

export interface FileTableUsage {
	open: number;
	max: number;
}

export interface FileHolder {
	pid: number;
	command: string;
	files: number;
}

export function readFileTableUsage(): FileTableUsage | undefined {
	try {
		if (platform() === "darwin") {
			const result = spawnSync(
				"sysctl",
				["-n", "kern.num_files", "kern.maxfiles"],
				{ encoding: "utf8" },
			);
			const [open, max] = result.stdout.trim().split("\n").map(Number);
			return open && max ? { open, max } : undefined;
		}
		// Linux: allocated, unused, max.
		const [allocated, unused, max] = readFileSync(
			"/proc/sys/fs/file-nr",
			"utf8",
		)
			.trim()
			.split(/\s+/)
			.map(Number);
		return allocated !== undefined && max
			? { open: allocated - (unused ?? 0), max }
			: undefined;
	} catch {
		return undefined;
	}
}

/** `lsof -F pcf` output → descriptors per process, most first. */
export function parseFileHolders(output: string, limit = 5): FileHolder[] {
	const holders = new Map<number, FileHolder>();
	let current: FileHolder | undefined;
	for (const line of output.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			const pid = Number(value);
			current = holders.get(pid) ?? { pid, command: "", files: 0 };
			holders.set(pid, current);
		} else if (field === "c" && current) current.command = value;
		else if (field === "f" && current) current.files++;
	}
	return [...holders.values()]
		.sort((a, b) => b.files - a.files)
		.slice(0, limit);
}

/**
 * The processes holding the most descriptors. One full `lsof`, which takes
 * seconds on a crowded machine: only worth it once the table is filling up.
 */
export function readTopFileHolders(limit = 5): FileHolder[] {
	const result = spawnSync("lsof", ["-n", "-P", "-F", "pcf"], {
		encoding: "utf8",
		maxBuffer: 512 * 1024 * 1024,
	});
	return parseFileHolders(result.stdout ?? "", limit);
}
