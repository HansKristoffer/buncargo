import type { DevServerPids } from "../../types";

/**
 * Stop a process by PID.
 */
export function stopProcess(pid: number): void {
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// Process may already be dead
	}
}

/**
 * Stop all processes by their PIDs.
 */
export function stopAllProcesses(
	pids: DevServerPids,
	options: { verbose?: boolean } = {},
): void {
	const { verbose = true } = options;

	for (const [name, pid] of Object.entries(pids)) {
		if (pid) {
			if (verbose) console.log(`   Stopping ${name} (PID: ${pid})`);
			stopProcess(pid);
		}
	}
}

/**
 * Check if a process is alive by sending signal 0.
 *
 * `EPERM` means the process exists and we are not allowed to signal it — the
 * ordinary answer when an unelevated CLI asks about the root hosts daemon.
 * Reading it as "dead" made a user run break the daemon's registry lock the
 * moment it held one, and prune away any route owned by a root process.
 * `ESRCH`, and anything else, is treated as gone.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
