import type { ChildProcess } from "node:child_process";
import { abortableSleep } from "../deadline";

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function ownedProcessAlive(child: ChildProcess): boolean {
	if (!child.pid) return false;
	// On macOS the group can disappear while its leader still awaits reaping.
	// Group disappearance alone does not acknowledge process cleanup.
	return (
		(process.platform !== "win32" && processExists(-child.pid)) ||
		processExists(child.pid)
	);
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// macOS can report EPERM for a group whose last member is exiting.
		// Keep waiting below; a real permission failure still times out.
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}

/** Only for children spawned detached by this invocation, never reused ports. */
export async function terminateOwnedProcess(
	child: ChildProcess,
	graceMs = 5000,
	initialSignal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
	if (!ownedProcessAlive(child)) return;
	signalGroup(child, initialSignal);
	const deadline = performance.now() + graceMs;
	while (ownedProcessAlive(child) && performance.now() < deadline)
		await abortableSleep(25);
	if (!ownedProcessAlive(child)) return;
	signalGroup(child, "SIGKILL");
	const killDeadline = performance.now() + 1000;
	while (ownedProcessAlive(child) && performance.now() < killDeadline)
		await abortableSleep(25);
	if (ownedProcessAlive(child))
		throw new Error(`Process group ${child.pid} did not exit after SIGKILL`);
}
