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
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
