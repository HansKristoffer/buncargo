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
	try {
		const tasks = readdirSync(`/proc/${pid}/task`);
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
	} catch {
		return undefined;
	}
}

export function collectProcessTree(pid: number): number[] {
	const seen = new Set<number>();
	const stack = [pid];

	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);

		const linuxChildren = linuxChildPids(current);
		if (linuxChildren !== undefined) {
			for (const child of linuxChildren) stack.push(child);
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
