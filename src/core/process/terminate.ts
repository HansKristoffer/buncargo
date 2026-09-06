import type { ChildProcess } from "node:child_process";
import { abortableSleep } from "../deadline";

function groupAlive(child: ChildProcess): boolean {
	if (!child.pid) return false;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

/** Only for children spawned detached by this invocation, never reused ports. */
export async function terminateOwnedProcess(
	child: ChildProcess,
	graceMs = 5000,
): Promise<void> {
	if (!groupAlive(child)) return;
	signalGroup(child, "SIGTERM");
	const deadline = performance.now() + graceMs;
	while (groupAlive(child) && performance.now() < deadline)
		await abortableSleep(25);
	if (!groupAlive(child)) return;
	signalGroup(child, "SIGKILL");
	const killDeadline = performance.now() + 1000;
	while (groupAlive(child) && performance.now() < killDeadline)
		await abortableSleep(25);
	if (groupAlive(child))
		throw new Error(`Process group ${child.pid} did not exit after SIGKILL`);
}
