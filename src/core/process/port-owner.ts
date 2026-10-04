import { execSync } from "node:child_process";
import { platform } from "node:os";
import { isAbsolute, relative } from "node:path";
import { containerRuntimeDisplayName } from "../../container-runtime/names";
import type { ContainerRuntimeAdapter } from "../../container-runtime/types";
import {
	dockerContainerPortOwners,
	dockerContainerPortOwnersAsync,
	findDockerContainerOnPort,
} from "../../docker/port-lookup";
import type { ContainerRuntimeName, PortContainerOwner } from "../../types";
import { externalStackProjectName } from "../ports";
import {
	matchesProcessIdentityAsync,
	readProcessIdentitiesAsync,
} from "../process-identity";
import {
	type ListenerSnapshot,
	readListenerSnapshot,
	readListenerSnapshotAsync,
	readProcessCwds,
	readProcessCwdsAsync,
} from "./port-snapshot";

/**
 * Who is holding a TCP port: a local process tree, a container, or nobody.
 * Everything here shells out to `lsof` / `netstat` / a container CLI, so every
 * helper degrades to "unknown" rather than throwing.
 */

export type { PortContainerOwner };

export interface PortOwnerLookupOptions {
	skipContainers?: boolean;
	/** Listeners to leave out, e.g. our own daemon sharing the port. */
	ignorePids?: number[];
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
	/**
	 * Nothing this user can list holds the port, yet it cannot be bound: a
	 * root process `lsof` hides, often a macOS service (Screen Sharing on
	 * :5900, AirPlay on :5000/:7000). Never one of ours, so always foreign.
	 */
	unidentified?: true;
}

const BIND_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::"] as const;

/**
 * Whether this process could listen on `port` right now.
 *
 * Every address is tried because they do not block each other: a listener on
 * `0.0.0.0` still lets `127.0.0.1` bind, and the reverse. Only `EADDRINUSE`
 * counts; an address the machine lacks (IPv6 turned off) says nothing.
 */
export function canBindPort(port: number): boolean {
	for (const hostname of BIND_PROBE_HOSTS) {
		try {
			Bun.listen({ hostname, port, socket: { data() {} } }).stop(true);
		} catch (error) {
			if ((error as { code?: string }).code === "EADDRINUSE") return false;
		}
	}
	return true;
}

/**
 * An owner lookup that also catches the holders it cannot see.
 *
 * The lookup answers from `lsof` and the container runtime. A port it reports
 * free but that will not bind is held by something invisible to this user, and
 * an app given that port drifts to the next one or never answers - which tore
 * down healthy apps along with it. Binding is only tried when the lookup found
 * nothing, so ports our own containers and processes hold are never touched.
 */
export function withBindProbe(
	lookup: (port: number) => PortOwner | null,
	canBind: (port: number) => boolean = canBindPort,
): (port: number) => PortOwner | null {
	return (port) =>
		lookup(port) ?? (canBind(port) ? null : { pids: [], unidentified: true });
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

/**
 * Container-held ports across the selected runtime and any fallbacks, in one
 * reading per runtime.
 *
 * The selected runtime wins a port both claim: it is the one this run can
 * actually start, exec into and tear down.
 */
export function containerPortOwnerMap(
	options: PortOwnerLookupOptions = {},
): Map<number, PortContainerOwner> {
	if (options.skipContainers) return new Map();
	const selected = options.runtime;
	const selectedName = selected?.name ?? "docker";
	const owners = new Map<number, PortContainerOwner>();

	const read = (
		runtime: ContainerRuntimeName,
		list: () => Map<number, PortContainerOwner>,
	): void => {
		try {
			for (const [port, owner] of list()) {
				if (!owners.has(port)) owners.set(port, { ...owner, runtime });
			}
		} catch {
			// A runtime that cannot answer simply is not the owner.
		}
	};

	read(selectedName, () =>
		selected ? selected.containerPortOwners() : dockerContainerPortOwners(),
	);
	for (const other of options.fallbackRuntimes ?? []) {
		if (other.name === selectedName) continue;
		read(other.name, () => other.containerPortOwners());
	}

	return owners;
}

export function findContainerOnPort(
	port: number,
	options: PortOwnerLookupOptions = {},
): PortContainerOwner | undefined {
	if (options.skipContainers) return undefined;
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

/**
 * Answers "who holds this port" for many ports from one reading of the system.
 *
 * A dev run asks the same question in four places — the port allocator, the
 * service preflight, the CLI's app classifier and the spawner — for every
 * service and app port. Each answer used to cost an `lsof`, a `docker ps`, a
 * `ps` and a second `lsof`, so a small config forked about thirty times before
 * the first dev server started.
 *
 * Deliberately a snapshot, not a cache with invalidation: it is created for a
 * phase, used, and thrown away. Anything that changes ownership on purpose —
 * `killPortOwner`, the takeover — takes a fresh reading instead.
 */
export interface PortOwnerSnapshot {
	owner(port: number): PortOwner | null;
	isBusy(port: number): boolean;
}

export function createPortOwnerSnapshot(
	options: PortOwnerLookupOptions & {
		/**
		 * Ports this snapshot will be asked about.
		 *
		 * Only used to batch the working-directory lookup, which is the one
		 * question that still needs a call per group of processes. Leaving it
		 * out is correct, just one extra `lsof` per distinct owner.
		 */
		ports?: number[];
		includeCwd?: boolean;
		listeners?: ListenerSnapshot;
		containers?: Map<number, PortContainerOwner>;
		cwds?: Map<number, string | undefined>;
	} = {},
): PortOwnerSnapshot {
	if (options.ports?.length === 0 && !options.listeners && !options.containers)
		return { owner: () => null, isBusy: () => false };
	const listeners = options.listeners ?? readListenerSnapshot();
	const containers = options.containers ?? containerPortOwnerMap(options);
	const cwds = options.cwds ?? new Map<number, string | undefined>();
	let pendingBatch: number[] | undefined = options.ports
		? [
				...new Set(
					options.ports.flatMap((port) => listeners.pidsByPort.get(port) ?? []),
				),
			]
		: undefined;

	function cwdFor(pid: number): string | undefined {
		if (cwds.has(pid)) return cwds.get(pid);
		// The first request resolves every pid this snapshot could be asked
		// about, so a run pays one call rather than one per app.
		const batch = pendingBatch?.includes(pid) ? pendingBatch : [pid];
		pendingBatch = undefined;
		const resolved = readProcessCwds(batch);
		for (const candidate of batch) {
			cwds.set(candidate, resolved.get(candidate));
		}
		return cwds.get(pid);
	}

	function owner(port: number): PortOwner | null {
		const pids = listeners.pidsByPort.get(port) ?? [];
		const container = containers.get(port);
		if (pids.length === 0 && !container) return null;
		const primaryPid = pids[0];
		return {
			pids,
			command:
				primaryPid !== undefined
					? listeners.commandByPid.get(primaryPid)
					: undefined,
			cwd:
				primaryPid !== undefined && !container && options.includeCwd !== false
					? cwdFor(primaryPid)
					: undefined,
			container,
		};
	}

	return {
		owner,
		isBusy: (port) =>
			(listeners.pidsByPort.get(port)?.length ?? 0) > 0 || containers.has(port),
	};
}

/** One cancellable reading per phase; listener and container listings run together. */
export async function createPortOwnerSnapshotAsync(
	options: Parameters<typeof createPortOwnerSnapshot>[0] & {
		signal?: AbortSignal;
	} = {},
): Promise<PortOwnerSnapshot> {
	options.signal?.throwIfAborted();
	if (options.ports?.length === 0 && !options.listeners && !options.containers)
		return { owner: () => null, isBusy: () => false };
	const readContainers = async (): Promise<Map<number, PortContainerOwner>> => {
		if (options.containers) return options.containers;
		if (options.skipContainers) return new Map();
		const selected = options.runtime;
		const names = [
			selected?.name ?? "docker",
			...(options.fallbackRuntimes ?? [])
				.filter((runtime) => runtime.name !== (selected?.name ?? "docker"))
				.map((runtime) => runtime.name),
		];
		const reads = [
			selected
				? () =>
						selected.containerPortOwnersAsync?.(options.signal) ??
						selected.containerPortOwners()
				: () => dockerContainerPortOwnersAsync(undefined, options.signal),
			...(options.fallbackRuntimes ?? [])
				.filter((runtime) => runtime.name !== (selected?.name ?? "docker"))
				.map(
					(runtime) => () =>
						runtime.containerPortOwnersAsync?.(options.signal) ??
						runtime.containerPortOwners(),
				),
		];
		const results = await Promise.allSettled(
			reads.map((read) => Promise.resolve().then(read)),
		);
		options.signal?.throwIfAborted();
		const owners = new Map<number, PortContainerOwner>();
		for (const [index, result] of results.entries()) {
			if (result.status !== "fulfilled") continue;
			for (const [port, owner] of result.value)
				if (!owners.has(port))
					owners.set(port, { ...owner, runtime: names[index] });
		}
		return owners;
	};
	const [listeners, containers] = await Promise.all([
		options.listeners ?? readListenerSnapshotAsync(options.signal),
		readContainers(),
	]);
	const pids = [
		...new Set(
			(options.ports ?? [...listeners.pidsByPort.keys()]).flatMap((port) =>
				containers.has(port) ? [] : (listeners.pidsByPort.get(port) ?? []),
			),
		),
	];
	const resolved =
		options.cwds ??
		(options.includeCwd === false
			? new Map()
			: await readProcessCwdsAsync(pids, options.signal));
	const cwds = new Map(pids.map((pid) => [pid, resolved.get(pid)]));
	options.signal?.throwIfAborted();
	return createPortOwnerSnapshot({ ...options, listeners, containers, cwds });
}

export function getPortOwner(
	port: number,
	options: PortOwnerLookupOptions = {},
): PortOwner | null {
	const ignore = new Set(options.ignorePids ?? []);
	const pids = getListeningPids(port).filter((pid) => !ignore.has(pid));
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
	const { verbose = false, timeout = 5000, runtime, skipContainers } = options;
	const owner = getPortOwner(port, { runtime, skipContainers });
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

	const originalIdentities = await readProcessIdentitiesAsync(owner.pids);
	for (const pid of owner.pids) {
		signalProcessTree(pid, "SIGTERM");
	}

	const startTime = Date.now();
	while (Date.now() - startTime < timeout) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		if (!isPortInUse(port, { runtime, skipContainers })) {
			if (verbose) console.log(`   ✓ Port ${port} released`);
			return true;
		}
	}

	if (verbose) {
		console.log(`   Process on port ${port} didn't exit, sending SIGKILL...`);
	}
	for (const pid of getListeningPids(port)) {
		const identity = originalIdentities.get(pid);
		if (identity && (await matchesProcessIdentityAsync(pid, identity)))
			signalProcessTree(pid, "SIGKILL");
	}
	await new Promise((resolve) => setTimeout(resolve, 500));
	const released = !isPortInUse(port, { runtime, skipContainers });
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
		/** This checkout's pre-12.0 project name (see `DevIdentity`). */
		legacyProjectName?: string;
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
		// An integration's stack (the Supabase CLI) labels its containers with
		// the shortened name it was given: those are this run's too.
		const project = owner.container.composeProject;
		if (
			sameRuntime &&
			project &&
			(project === options.projectName ||
				project === options.legacyProjectName ||
				project === externalStackProjectName(options.projectName))
		) {
			return "reuse";
		}
		return "fail";
	}
	const localPath =
		owner.cwd === undefined ? undefined : relative(options.root, owner.cwd);
	if (
		localPath !== undefined &&
		localPath !== ".." &&
		!localPath.startsWith("../") &&
		!localPath.startsWith("..\\") &&
		!isAbsolute(localPath)
	) {
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
	if (owner.unidentified)
		return `port ${port} is held by an unidentified process (one this user cannot list, often a system service)`;
	const command = owner.command ? ` (${owner.command})` : "";
	const cwd = owner.cwd ? ` in ${owner.cwd}` : "";
	const pid = owner.pids[0] ?? "unknown";
	return `port ${port} held by process ${pid}${command}${cwd}`;
}
