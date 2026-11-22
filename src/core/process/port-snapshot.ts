import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { recordStartupMetric } from "../startup-metrics";

/**
 * One reading of every TCP listener on the machine.
 *
 * Asking `lsof` per port is what a dev run used to do: three times per port,
 * plus a `ps` and a second `lsof` for each owner, and every one of those is a
 * fork. On macOS a single `lsof` answers every port at once. On Linux we read
 * `/proc/net/tcp{,6}` and `/proc/<pid>/{fd,comm,cwd}` directly, forking
 * nothing and skipping the `/proc/<pid>/fd` scan altogether when none of the
 * asked ports is listening.
 *
 * Everything here degrades to "nothing found" rather than throwing: a machine
 * without `lsof` or `/proc`, or a sandbox that refuses them, must still be
 * able to start a dev environment.
 */

export interface ListenerSnapshot {
	/** Listening pids per host port. */
	pidsByPort: Map<number, number[]>;
	/** Executable name per pid, as `lsof` or `/proc/<pid>/comm` reports it. */
	commandByPid: Map<number, string>;
}

export function emptyListenerSnapshot(): ListenerSnapshot {
	return { pidsByPort: new Map(), commandByPid: new Map() };
}

/** Listening socket inodes per host port, from `/proc/net/tcp{,6}`. */
export type ListeningInodesByPort = Map<number, string[]>;

const PROC_TCP_FILES = ["/proc/net/tcp", "/proc/net/tcp6"] as const;
const TCP_LISTEN_STATE = "0A";

/**
 * Parse `/proc/net/tcp` or `/proc/net/tcp6` into `port -> socket inodes` for
 * sockets in `TCP_LISTEN` (`0A`). When `wantPorts` is given, only those ports
 * are kept so callers do not pay to scan `/proc/<pid>/fd` for unrelated apps.
 */
export function parseProcNetTcp(
	content: string,
	wantPorts?: ReadonlySet<number>,
	target: ListeningInodesByPort = new Map(),
): ListeningInodesByPort {
	let pos = content.indexOf("\n") + 1;
	while (pos > 0 && pos < content.length) {
		const end = content.indexOf("\n", pos);
		const line = end === -1 ? content.slice(pos) : content.slice(pos, end);
		pos = end === -1 ? content.length : end + 1;

		const trimmed = line.trim();
		if (!trimmed) continue;
		const fields = trimmed.split(/\s+/);
		if (fields[3] !== TCP_LISTEN_STATE) continue;

		const local = fields[1];
		const inode = fields[9];
		if (!local || !inode || inode === "0") continue;

		const colon = local.lastIndexOf(":");
		if (colon === -1) continue;
		const port = Number.parseInt(local.slice(colon + 1), 16);
		if (!Number.isInteger(port) || port <= 0) continue;
		if (wantPorts && !wantPorts.has(port)) continue;

		const existing = target.get(port);
		if (!existing) target.set(port, [inode]);
		else if (!existing.includes(inode)) existing.push(inode);
	}
	return target;
}

function portFilter(
	ports?: readonly number[],
): ReadonlySet<number> | undefined {
	return ports ? new Set(ports) : undefined;
}

/**
 * Read listening `(port -> socket inodes)` from `/proc/net/tcp{,6}` on Linux.
 * Returns `undefined` when `/proc/net` is unavailable so callers fall back to `lsof`.
 */
export function readLinuxListeningInodes(
	ports?: readonly number[],
): ListeningInodesByPort | undefined {
	if (process.platform !== "linux") return undefined;
	const want = portFilter(ports);
	const inodesByPort: ListeningInodesByPort = new Map();
	let readAny = false;

	for (const file of PROC_TCP_FILES) {
		try {
			parseProcNetTcp(readFileSync(file, "utf8"), want, inodesByPort);
			readAny = true;
		} catch {
			// IPv6 may be disabled or `/proc/net` restricted.
		}
	}

	return readAny ? inodesByPort : undefined;
}

/** Async counterpart: reads `/proc/net/tcp` and `/proc/net/tcp6` in parallel. */
export async function readLinuxListeningInodesAsync(
	signal?: AbortSignal,
	ports?: readonly number[],
): Promise<ListeningInodesByPort | undefined> {
	signal?.throwIfAborted();
	if (process.platform !== "linux") return undefined;

	const results = await Promise.all(
		PROC_TCP_FILES.map((file) =>
			readFile(file, { encoding: "utf8", signal }).catch(() => undefined),
		),
	);
	signal?.throwIfAborted();

	const want = portFilter(ports);
	const inodesByPort: ListeningInodesByPort = new Map();
	let readAny = false;
	for (const content of results) {
		if (content === undefined) continue;
		readAny = true;
		parseProcNetTcp(content, want, inodesByPort);
	}
	return readAny ? inodesByPort : undefined;
}

/**
 * Map a set of listening `(port -> socket inodes)` to their owning pids and
 * executable names by scanning `/proc/<pid>/fd`. Skips the scan completely
 * when `inodesByPort` is empty.
 */
export function resolveLinuxInodeOwners(
	inodesByPort: ListeningInodesByPort,
): ListenerSnapshot {
	const snapshot = emptyListenerSnapshot();
	if (inodesByPort.size === 0) return snapshot;

	const portsByInode = new Map<string, number[]>();
	for (const [port, inodes] of inodesByPort) {
		for (const inode of inodes) {
			const list = portsByInode.get(inode);
			if (!list) portsByInode.set(inode, [port]);
			else if (!list.includes(port)) list.push(port);
		}
	}

	let entries: string[];
	try {
		entries = readdirSync("/proc");
	} catch {
		return snapshot;
	}

	for (const entry of entries) {
		const first = entry.charCodeAt(0);
		if (first < 48 || first > 57) continue;
		const pid = Number.parseInt(entry, 10);
		if (!Number.isInteger(pid) || pid <= 0) continue;

		let fds: string[];
		try {
			fds = readdirSync(`/proc/${entry}/fd`);
		} catch {
			// Another user's process, or exited mid-scan.
			continue;
		}

		let matched = false;
		for (const fd of fds) {
			let link: string;
			try {
				link = readlinkSync(`/proc/${entry}/fd/${fd}`);
			} catch {
				continue;
			}
			if (!link.startsWith("socket:[")) continue;
			const ports = portsByInode.get(link.slice(8, -1));
			if (!ports) continue;

			matched = true;
			for (const port of ports) {
				const list = snapshot.pidsByPort.get(port);
				if (!list) snapshot.pidsByPort.set(port, [pid]);
				else if (!list.includes(pid)) list.push(pid);
			}
		}

		if (matched) {
			try {
				const comm = readFileSync(`/proc/${entry}/comm`, "utf8").trim();
				if (comm) snapshot.commandByPid.set(pid, comm);
			} catch {
				// Exited after matching; pid is still recorded.
			}
		}
	}

	return snapshot;
}

/**
 * Host port from an `lsof` name field.
 *
 * Handles `*:3000`, `127.0.0.1:5432` and `[::1]:5173`; the last colon is the
 * port separator in all three, which is why an IPv6 address does not need
 * unwrapping first.
 */
function portFromLsofName(name: string): number | undefined {
	const colon = name.lastIndexOf(":");
	if (colon === -1) return undefined;
	const port = Number.parseInt(name.slice(colon + 1), 10);
	return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** The pid of an `lsof` `p` field, or undefined for one that is not a pid. */
function pidFromLsofField(value: string): number | undefined {
	const pid = Number.parseInt(value, 10);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Parse `lsof -F pcn` output.
 *
 * The format is a stream of one-letter-prefixed lines: `p` opens a process
 * block, `c` names it, and each `n` is one of its files, here one listening
 * socket, because the caller filtered on `-sTCP:LISTEN`.
 */
function parseListenerSnapshot(output: string): ListenerSnapshot {
	const snapshot = emptyListenerSnapshot();
	let pid: number | undefined;

	for (const line of output.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			pid = pidFromLsofField(value);
			continue;
		}
		if (pid === undefined) continue;

		if (field === "c") {
			snapshot.commandByPid.set(pid, value.trim());
			continue;
		}
		if (field !== "n") continue;

		const port = portFromLsofName(value.trim());
		if (port === undefined) continue;
		const existing = snapshot.pidsByPort.get(port);
		if (!existing) {
			snapshot.pidsByPort.set(port, [pid]);
		} else if (!existing.includes(pid)) {
			// A server bound to both loopback families is two sockets, one pid.
			existing.push(pid);
		}
	}

	return snapshot;
}

/** Parse `lsof -d cwd -F pn` output into `pid -> working directory`. */
function parseProcessCwds(output: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid: number | undefined;

	for (const line of output.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			pid = pidFromLsofField(value);
			continue;
		}
		if (field === "n" && pid !== undefined) {
			const cwd = value.trim();
			if (cwd) cwds.set(pid, cwd);
		}
	}

	return cwds;
}

function runQuietly(command: string, args: string[]): string | undefined {
	try {
		recordStartupMetric("subprocesses");
		return execFileSync(command, args, {
			timeout: 5000,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		// `lsof` exits non-zero when nothing matched, having still written what
		// it found. An empty stdout and a real failure are the same to us.
		const output = (error as { stdout?: string }).stdout;
		return typeof output === "string" ? output : undefined;
	}
}

/** Every TCP listener on this machine (or those on `ports`), in one reading. */
export function readListenerSnapshot(
	ports?: readonly number[],
): ListenerSnapshot {
	if (ports?.length === 0) return emptyListenerSnapshot();
	const linux = readLinuxListeningInodes(ports);
	if (linux !== undefined) return resolveLinuxInodeOwners(linux);

	const output = runQuietly("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
	return output ? parseListenerSnapshot(output) : emptyListenerSnapshot();
}

/**
 * Working directories for a set of pids, in one call.
 *
 * Only asked for the handful of processes that turned out to hold a port this
 * run cares about. The cwd is what separates an orphan of this repo, which is
 * killed, from a stranger's process, which is not.
 */
export function readProcessCwds(pids: number[]): Map<number, string> {
	if (pids.length === 0) return new Map();
	if (process.platform === "linux") {
		const cwds = new Map<number, string>();
		for (const pid of pids) {
			try {
				const cwd = readlinkSync(`/proc/${pid}/cwd`);
				if (cwd) cwds.set(pid, cwd);
			} catch {
				// Process exited or belongs to another user.
			}
		}
		return cwds;
	}

	const output = runQuietly("lsof", [
		"-a",
		"-p",
		pids.join(","),
		"-d",
		"cwd",
		"-Fpn",
	]);
	return output ? parseProcessCwds(output) : new Map();
}

/** Asynchronous inventory reads keep cancellation and other startups responsive. */
function runQuietlyAsync(
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	recordStartupMetric("subprocesses");
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ encoding: "utf8", timeout: 5000, signal, killSignal: "SIGKILL" },
			(_error, stdout) => {
				if (signal?.aborted) reject(signal.reason);
				else resolve(stdout ?? "");
			},
		);
	});
}

export async function readListenerSnapshotAsync(
	signal?: AbortSignal,
	ports?: readonly number[],
): Promise<ListenerSnapshot> {
	signal?.throwIfAborted();
	if (ports?.length === 0) return emptyListenerSnapshot();

	const linux = await readLinuxListeningInodesAsync(signal, ports);
	if (linux !== undefined) {
		signal?.throwIfAborted();
		return resolveLinuxInodeOwners(linux);
	}

	return parseListenerSnapshot(
		await runQuietlyAsync(
			"lsof",
			["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
			signal,
		),
	);
}

export async function readProcessCwdsAsync(
	pids: number[],
	signal?: AbortSignal,
): Promise<Map<number, string>> {
	signal?.throwIfAborted();
	if (pids.length === 0) return new Map();
	if (process.platform === "linux") {
		const cwds = new Map<number, string>();
		const results = await Promise.all(
			pids.map(async (pid) => {
				try {
					return [pid, await readlink(`/proc/${pid}/cwd`)] as const;
				} catch {
					return undefined;
				}
			}),
		);
		signal?.throwIfAborted();
		for (const entry of results) {
			if (entry?.[1]) cwds.set(entry[0], entry[1]);
		}
		return cwds;
	}

	return parseProcessCwds(
		await runQuietlyAsync(
			"lsof",
			["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"],
			signal,
		),
	);
}
