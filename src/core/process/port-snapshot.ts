import { execFileSync } from "node:child_process";
import { platform } from "node:os";

/**
 * One reading of every TCP listener on the machine.
 *
 * Asking `lsof` per port is what a dev run used to do — three times per port,
 * plus a `ps` and a second `lsof` for each owner — and every one of those is a
 * fork. A single `lsof` answers the same questions for every port at once, at
 * the cost of one, and the answer cannot be inconsistent between two ports of
 * the same run.
 *
 * Everything here degrades to "nothing found" rather than throwing: a machine
 * without `lsof`, or a sandbox that refuses it, must still be able to start a
 * dev environment.
 */

export interface ListenerSnapshot {
	/** Listening pids per host port. */
	pidsByPort: Map<number, number[]>;
	/** Executable name per pid, as `lsof` reports it. */
	commandByPid: Map<number, string>;
}

export function emptyListenerSnapshot(): ListenerSnapshot {
	return { pidsByPort: new Map(), commandByPid: new Map() };
}

/**
 * Host port from an `lsof` name field.
 *
 * Handles `*:3000`, `127.0.0.1:5432` and `[::1]:5173`; the last colon is the
 * port separator in all three, which is why an IPv6 address does not need
 * unwrapping first.
 */
export function portFromLsofName(name: string): number | undefined {
	const colon = name.lastIndexOf(":");
	if (colon === -1) return undefined;
	const port = Number.parseInt(name.slice(colon + 1), 10);
	return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Parse `lsof -F pcn` output.
 *
 * The format is a stream of one-letter-prefixed lines: `p` opens a process
 * block, `c` names it, and each `n` is one of its files — here, one listening
 * socket, because the caller filtered on `-sTCP:LISTEN`.
 */
export function parseListenerSnapshot(output: string): ListenerSnapshot {
	const snapshot = emptyListenerSnapshot();
	let pid: number | undefined;

	for (const line of output.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			const parsed = Number.parseInt(value, 10);
			pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
export function parseProcessCwds(output: string): Map<number, string> {
	const cwds = new Map<number, string>();
	let pid: number | undefined;

	for (const line of output.split("\n")) {
		const field = line[0];
		const value = line.slice(1);
		if (field === "p") {
			const parsed = Number.parseInt(value, 10);
			pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
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
		return execFileSync(command, args, {
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

/**
 * Windows has no `lsof`; `netstat` reports the pid but not the command name.
 *
 * Named hosts and the container backends are POSIX-only anyway, so this exists
 * to keep port reuse working rather than to reach parity.
 */
function readWindowsListeners(): ListenerSnapshot {
	const snapshot = emptyListenerSnapshot();
	const output = runQuietly("netstat", ["-ano"]);
	if (!output) return snapshot;

	for (const line of output.split("\n")) {
		if (!line.includes("LISTENING")) continue;
		const parts = line.trim().split(/\s+/);
		const local = parts[1];
		const pid = Number.parseInt(parts[parts.length - 1] ?? "", 10);
		if (!local || !Number.isInteger(pid) || pid <= 0) continue;
		const port = portFromLsofName(local);
		if (port === undefined) continue;
		const existing = snapshot.pidsByPort.get(port);
		if (!existing) snapshot.pidsByPort.set(port, [pid]);
		else if (!existing.includes(pid)) existing.push(pid);
	}

	return snapshot;
}

/** Every TCP listener on this machine, in one call. */
export function readListenerSnapshot(): ListenerSnapshot {
	if (platform() === "win32") return readWindowsListeners();
	const output = runQuietly("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
	return output ? parseListenerSnapshot(output) : emptyListenerSnapshot();
}

/**
 * Working directories for a set of pids, in one call.
 *
 * Only asked for the handful of processes that turned out to hold a port this
 * run cares about — the cwd is what separates an orphan of this repo, which is
 * killed, from a stranger's process, which is not.
 */
export function readProcessCwds(pids: number[]): Map<number, string> {
	if (pids.length === 0 || platform() === "win32") return new Map();
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
