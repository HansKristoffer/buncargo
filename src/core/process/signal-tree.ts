import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

function parsePids(output: string): number[] {
	return output
		.split(/\r?\n/)
		.map((line) => Number.parseInt(line.trim(), 10))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

/** Direct child pids of `pid` from Linux `/proc`, or `undefined` when unavailable. */
function linuxChildPids(pid: number): number[] | undefined {
	if (process.platform !== "linux") return undefined;
	let tasks: string[];
	try {
		tasks = readdirSync(`/proc/${pid}/task`);
	} catch (error) {
		// Process already exited: no children to find, and no need to fork `pgrep`.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		return undefined;
	}
	const children: number[] = [];
	let readAny = false;
	for (const tid of tasks) {
		try {
			const raw = readFileSync(`/proc/${pid}/task/${tid}/children`, "utf8");
			readAny = true;
			for (const token of raw.trim().split(/\s+/)) {
				const child = Number.parseInt(token, 10);
				if (Number.isInteger(child) && child > 0) children.push(child);
			}
		} catch {
			// Task exited mid-read, or kernel lacks CONFIG_PROC_CHILDREN.
		}
	}
	return readAny ? children : undefined;
}

/** Build `ppid -> direct child pids` with one `ps` call instead of recursive `pgrep` forks. */
function psChildrenMap(): Map<number, number[]> | undefined {
	try {
		const output = execFileSync("ps", ["-eo", "pid=,ppid="], {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		const byParent = new Map<number, number[]>();
		for (const line of output.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const parts = trimmed.split(/\s+/);
			const pid = Number.parseInt(parts[0] ?? "", 10);
			const ppid = Number.parseInt(parts[1] ?? "", 10);
			if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid)) {
				continue;
			}
			const list = byParent.get(ppid);
			if (list) list.push(pid);
			else byParent.set(ppid, [pid]);
		}
		return byParent;
	} catch {
		return undefined;
	}
}

export function collectProcessTree(pid: number): number[] {
	const seen = new Set<number>();
	const stack = [pid];
	let psChildren: Map<number, number[]> | null | undefined;

	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);

		const linuxChildren = linuxChildPids(current);
		if (linuxChildren !== undefined) {
			for (const child of linuxChildren) stack.push(child);
			continue;
		}

		if (psChildren === undefined) {
			psChildren = psChildrenMap() ?? null;
		}
		if (psChildren !== null) {
			for (const child of psChildren.get(current) ?? []) {
				stack.push(child);
			}
			continue;
		}

		try {
			const output = execFileSync("pgrep", ["-P", String(current)], {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			for (const child of parsePids(output)) {
				stack.push(child);
			}
		} catch {
			// `pgrep` exits non-zero when the process has no children.
		}
	}

	return Array.from(seen);
}

function permissionError(pid: number, signal: NodeJS.Signals): Error {
	return new Error(
		`Cannot signal process ${pid} (${signal}): permission denied. The port may be held by Docker or another user's process.`,
	);
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? (error as NodeJS.ErrnoException).code
		: undefined;
}

export function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch (error) {
		if (errorCode(error) === "EPERM") {
			throw permissionError(pid, signal);
		}
	}

	for (const childPid of collectProcessTree(pid)) {
		try {
			process.kill(childPid, signal);
		} catch (error) {
			if (errorCode(error) === "EPERM") {
				throw permissionError(childPid, signal);
			}
		}
	}
}
