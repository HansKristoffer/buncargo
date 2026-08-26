import { execSync } from "node:child_process";
import { platform } from "node:os";

/**
 * Who is holding a TCP port: a local process tree, a Docker container, or
 * nobody. Everything here shells out to `lsof` / `netstat` / `docker ps`, so
 * every helper degrades to "unknown" rather than throwing.
 */

export interface PortContainerOwner {
	id: string;
	name: string;
	composeProject?: string;
}

export interface PortOwner {
	pids: number[];
	command?: string;
	cwd?: string;
	container?: PortContainerOwner;
}

function parsePids(output: string): number[] {
	const pids = new Set<number>();
	for (const line of output.split("\n")) {
		const pid = Number.parseInt(line.trim(), 10);
		if (!Number.isNaN(pid) && pid > 0) {
			pids.add(pid);
		}
	}
	return Array.from(pids);
}

export function getListeningPids(port: number): number[] {
	try {
		const os = platform();
		if (os === "win32") {
			const output = execSync(`netstat -ano | findstr :${port}`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const pids: number[] = [];
			for (const line of output.trim().split("\n")) {
				if (!line.includes("LISTENING")) continue;
				const parts = line.trim().split(/\s+/);
				const pid = Number.parseInt(parts[parts.length - 1], 10);
				if (!Number.isNaN(pid) && pid > 0) {
					pids.push(pid);
				}
			}
			return Array.from(new Set(pids));
		}

		const output = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return parsePids(output);
	} catch {
		return [];
	}
}

function processCommand(pid: number): string | undefined {
	try {
		return (
			execSync(`ps -p ${pid} -o comm=`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			}).trim() || undefined
		);
	} catch {
		return undefined;
	}
}

function processCwd(pid: number): string | undefined {
	try {
		const output = execSync(`lsof -a -p ${pid} -d cwd -Fn`, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		for (const line of output.split("\n")) {
			if (line.startsWith("n")) {
				return line.slice(1).trim() || undefined;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function parseDockerPublishedPort(
	portsField: string,
	port: number,
): boolean {
	const pattern = new RegExp(
		`(?:^|,|\\s)(?:\\[::\\]|0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\*):${port}->`,
	);
	return pattern.test(portsField) || new RegExp(`:${port}->`).test(portsField);
}

export function findContainerOnPort(
	port: number,
): PortContainerOwner | undefined {
	try {
		const output = execSync(
			'docker ps --format "{{.ID}}\\t{{.Names}}\\t{{.Ports}}\\t{{.Label \\"com.docker.compose.project\\"}}"',
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		for (const line of output.trim().split("\n")) {
			if (!line) continue;
			const [id, name, portsField, composeProject] = line.split("\t");
			if (!id || !portsField || !parseDockerPublishedPort(portsField, port)) {
				continue;
			}
			return {
				id,
				name: name ?? id,
				composeProject: composeProject || undefined,
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function getPortOwner(port: number): PortOwner | null {
	const pids = getListeningPids(port);
	const container = findContainerOnPort(port);
	if (pids.length === 0 && !container) {
		return null;
	}
	const primaryPid = pids[0];
	return {
		pids,
		command: primaryPid !== undefined ? processCommand(primaryPid) : undefined,
		cwd: primaryPid !== undefined ? processCwd(primaryPid) : undefined,
		container,
	};
}

/**
 * Get the PID of the process using a specific port.
 * Returns null if no process is using the port.
 */
export function getProcessOnPort(port: number): number | null {
	return getListeningPids(port)[0] ?? null;
}

/**
 * Check if a port is currently in use.
 *
 * Ownership-based: reports a listening process or published container port.
 * Compare with `isPortAvailable` in `core/network.ts`, which connect-probes.
 */
export function isPortInUse(port: number): boolean {
	return getPortOwner(port) !== null;
}

export function collectProcessTree(pid: number): number[] {
	const seen = new Set<number>();
	const stack = [pid];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		try {
			const output = execSync(`pgrep -P ${current}`, {
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			for (const child of parsePids(output)) {
				stack.push(child);
			}
		} catch {
			// no children
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

export async function killPortOwner(
	port: number,
	options: { verbose?: boolean; timeout?: number } = {},
): Promise<boolean> {
	const { verbose = false, timeout = 5000 } = options;
	const owner = getPortOwner(port);
	if (!owner) {
		return false;
	}

	if (owner.container && owner.pids.length === 0) {
		throw new Error(
			`Port ${port} is held by container ${owner.container.name}${
				owner.container.composeProject
					? ` (project ${owner.container.composeProject})`
					: ""
			}`,
		);
	}

	if (verbose) {
		console.log(
			`   Killing process ${owner.pids.join(", ")} on port ${port}...`,
		);
	}

	for (const pid of owner.pids) {
		signalProcessTree(pid, "SIGTERM");
	}

	const startTime = Date.now();
	while (Date.now() - startTime < timeout) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!isPortInUse(port)) {
			if (verbose) console.log(`   ✓ Port ${port} released`);
			return true;
		}
	}

	if (verbose) {
		console.log(`   Process on port ${port} didn't exit, sending SIGKILL...`);
	}
	for (const pid of getListeningPids(port)) {
		signalProcessTree(pid, "SIGKILL");
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	const released = !isPortInUse(port);
	if (verbose) {
		console.log(
			released
				? `   ✓ Port ${port} released after SIGKILL`
				: `   ⚠ Port ${port} still in use`,
		);
	}
	return released;
}

export type PortOccupantAction = "reuse" | "kill" | "fail" | "free";

export function classifyPortOccupant(
	owner: PortOwner | null,
	options: { root: string; projectName: string },
): PortOccupantAction {
	if (!owner) return "free";
	if (
		owner.container?.composeProject &&
		owner.container.composeProject === options.projectName
	) {
		return "reuse";
	}
	if (owner.container) {
		return "fail";
	}
	if (owner.cwd?.startsWith(options.root)) {
		return "kill";
	}
	return "fail";
}

export function formatPortOwner(port: number, owner: PortOwner): string {
	if (owner.container) {
		const project = owner.container.composeProject
			? ` (project ${owner.container.composeProject})`
			: "";
		return `port ${port} held by container ${owner.container.name}${project}`;
	}
	const command = owner.command ? ` (${owner.command})` : "";
	const cwd = owner.cwd ? ` in ${owner.cwd}` : "";
	const pid = owner.pids[0] ?? "unknown";
	return `port ${port} held by process ${pid}${command}${cwd}`;
}
