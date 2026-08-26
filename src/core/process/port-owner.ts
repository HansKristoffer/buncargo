import { execSync } from "node:child_process";
import { platform } from "node:os";
import { containerRuntimeDisplayName } from "../../container-runtime/names";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import { findDockerContainerOnPort } from "../../docker/port-lookup";
import type { ContainerRuntimeName, PortContainerOwner } from "../../types";

/**
 * Who is holding a TCP port: a local process tree, a container, or nobody.
 * Everything here shells out to `lsof` / `netstat` / a container CLI, so every
 * helper degrades to "unknown" rather than throwing.
 */

export type { PortContainerOwner };

export interface PortOwnerLookupOptions {
	/**
	 * Runtime to ask about container-held ports.
	 *
	 * Defaults to Docker, which is right for the callers that leave it out: the
	 * `:443` squatter check and the dev-server ports, where the holder is a
	 * local process and the container lookup only enriches the message. The
	 * service ports, where the holder really can be a container on either
	 * runtime, pass the resolved one.
	 */
	runtime?: ContainerRuntimeAdapter;
	/**
	 * Runtimes to ask when the selected one has no container on the port.
	 *
	 * A container left behind by the other backend still holds the port, but to
	 * the selected runtime it is invisible, so the message degrades to the
	 * daemon process that owns the socket - `com.docker.backend` rather than
	 * "the Docker container from this same project". Passed in rather than
	 * resolved here so `core/` stays below the runtime-resolution layer, and so
	 * `killPortOwner`'s poll loop does not probe every runtime ten times a
	 * second for an answer only the startup check reports.
	 */
	fallbackRuntimes?: ContainerRuntimeAdapter[];
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

export function findContainerOnPort(
	port: number,
	options: PortOwnerLookupOptions = {},
): PortContainerOwner | undefined {
	const selected = options.runtime;
	const found = selected
		? selected.findContainerOnPort(port)
		: findDockerContainerOnPort(port);
	if (found) {
		return { ...found, runtime: selected?.name ?? "docker" };
	}

	for (const other of options.fallbackRuntimes ?? []) {
		if (other.name === (selected?.name ?? "docker")) continue;
		try {
			const foreign = other.findContainerOnPort(port);
			if (foreign) return { ...foreign, runtime: other.name };
		} catch {
			// A runtime that cannot answer simply is not the owner.
		}
	}
	return undefined;
}

export function getPortOwner(
	port: number,
	options: PortOwnerLookupOptions = {},
): PortOwner | null {
	const pids = getListeningPids(port);
	const container = findContainerOnPort(port, options);
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
export function isPortInUse(
	port: number,
	options: PortOwnerLookupOptions = {},
): boolean {
	return getPortOwner(port, options) !== null;
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
	options: PortOwnerLookupOptions & {
		verbose?: boolean;
		timeout?: number;
	} = {},
): Promise<boolean> {
	const { verbose = false, timeout = 5000, runtime } = options;
	const owner = getPortOwner(port, { runtime });
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
		if (!isPortInUse(port, { runtime })) {
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
	const released = !isPortInUse(port, { runtime });
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
	options: {
		root: string;
		projectName: string;
		/** The backend this run will use; anything else cannot be reused. */
		runtime?: ContainerRuntimeName;
	},
): PortOccupantAction {
	if (!owner) return "free";
	if (owner.container) {
		// A container of ours on the other backend still has to go: this run
		// cannot start, exec into or tear it down through the runtime it chose.
		const sameRuntime =
			options.runtime === undefined ||
			owner.container.runtime === undefined ||
			owner.container.runtime === options.runtime;
		if (
			sameRuntime &&
			owner.container.composeProject === options.projectName &&
			owner.container.composeProject
		) {
			return "reuse";
		}
		return "fail";
	}
	if (owner.cwd?.startsWith(options.root)) {
		return "kill";
	}
	return "fail";
}

export function formatPortOwner(
	port: number,
	owner: PortOwner,
	options: { runtime?: ContainerRuntimeName } = {},
): string {
	if (owner.container) {
		const { container } = owner;
		const project = container.composeProject
			? ` (project ${container.composeProject})`
			: "";

		const base = `port ${port} held by container ${container.name}${project}`;

		// Name the backend only when it is not the one this run selected.
		// Saying "on Docker" to someone who only has Docker is noise; saying it
		// to someone running Apple is the whole answer. The runtime is a product
		// name rather than an adjective, so it goes after the noun: "Apple
		// container" cannot qualify "container".
		const selected = options.runtime;
		const holder = container.runtime;
		if (selected !== undefined && holder !== undefined && holder !== selected) {
			return `${base}, running on ${containerRuntimeDisplayName(holder)} while this project is configured for ${containerRuntimeDisplayName(selected)}. Stop it with \`buncargo dev --down --runtime=${holder}\`, or set docker.runtime to "${holder}".`;
		}
		return base;
	}
	const command = owner.command ? ` (${owner.command})` : "";
	const cwd = owner.cwd ? ` in ${owner.cwd}` : "";
	const pid = owner.pids[0] ?? "unknown";
	return `port ${port} held by process ${pid}${command}${cwd}`;
}
