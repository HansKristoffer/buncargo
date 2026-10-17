import { abortableSleep } from "../deadline";
import { matchesProcessIdentityAsync } from "../process-identity";
import { DetachedApp } from "./detached-app";
import { isProcessAlive } from "./lifecycle";
import { signalProcessTree } from "./port-owner";
import type { AppChild } from "./pty-app";

function exitSeen(child: AppChild | DetachedApp): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function groupAlive(pid: number): boolean {
	return process.platform !== "win32" && isProcessAlive(-pid);
}

/**
 * Exited children whose group was then seen empty. From that moment the group
 * id can name an unrelated group, so the answer stays "gone" for good.
 */
const emptiedGroups = new WeakSet<AppChild | DetachedApp>();
const groupWatches = new WeakMap<AppChild | DetachedApp, Promise<void>>();

/** Whether anything of `child` (its leader, or what is left of its group) still runs. */
export function ownedProcessAlive(child: AppChild | DetachedApp): boolean {
	if (!child.pid) return false;
	// Its identity stopped matching: whatever holds that pid now is not ours.
	if (child instanceof DetachedApp && child.exitCode !== null) return false;
	if (emptiedGroups.has(child)) return false;
	if (groupAlive(child.pid)) return true;
	// On macOS the group can disappear while its leader still awaits reaping,
	// so group disappearance alone does not acknowledge process cleanup. Once
	// the exit was seen the leader is reaped, and its pid may be reused.
	if (!exitSeen(child)) return isProcessAlive(child.pid);
	emptiedGroups.add(child);
	return false;
}

/**
 * Resolves once nothing of `child` runs any more. A leader often exits while
 * its group lives on (`bun run dev`, `sh -c` wrappers); polling the group
 * sees it empty before an unrelated group can take its id, which
 * {@link ownedProcessAlive} then never mistakes for ours. One unref'd poll
 * per child, however many callers wait on it.
 */
export function ownedProcessGone(
	child: AppChild | DetachedApp,
	pollMs = 250,
): Promise<void> {
	let watch = groupWatches.get(child);
	if (!watch) {
		watch = new Promise<void>((resolve) => {
			if (!ownedProcessAlive(child)) return resolve();
			const timer = setInterval(() => {
				if (ownedProcessAlive(child)) return;
				clearInterval(timer);
				resolve();
			}, pollMs);
			timer.unref();
		});
		groupWatches.set(child, watch);
	}
	return watch;
}

/**
 * Whether a process this invocation did not spawn is still the one it took
 * over. A leader that is gone while its group lives is: a group id is never
 * handed to a new process while any member of the group remains.
 */
async function stillOurs(child: AppChild | DetachedApp): Promise<boolean> {
	if (!(child instanceof DetachedApp)) return true;
	if (!isProcessAlive(child.pid)) return true;
	return matchesProcessIdentityAsync(child.pid, child.identity);
}

function signalGroup(
	child: AppChild | DetachedApp,
	signal: NodeJS.Signals,
): void {
	if (!child.pid) return;
	if (child instanceof DetachedApp) {
		signalProcessTree(child.pid, signal);
		return;
	}
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// macOS can report EPERM for a group whose last member is exiting.
		// Keep waiting below; a real permission failure still times out.
		if (code !== "ESRCH" && code !== "EPERM") throw error;
	}
}

async function signalUntilGone(
	child: AppChild | DetachedApp,
	graceMs: number,
	initialSignal: NodeJS.Signals,
): Promise<void> {
	signalGroup(child, initialSignal);
	const deadline = performance.now() + graceMs;
	while (ownedProcessAlive(child) && performance.now() < deadline)
		await abortableSleep(25);
	if (!ownedProcessAlive(child) || !(await stillOurs(child))) return;
	signalGroup(child, "SIGKILL");
	const killDeadline = performance.now() + 1000;
	while (ownedProcessAlive(child) && performance.now() < killDeadline)
		await abortableSleep(25);
	if (ownedProcessAlive(child))
		throw new Error(`Process group ${child.pid} did not exit after SIGKILL`);
}

/** Only for children spawned detached by this invocation, never reused ports. */
export async function terminateOwnedProcess(
	child: AppChild | DetachedApp,
	graceMs = 5000,
	initialSignal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
	if (!ownedProcessAlive(child) || !(await stillOurs(child))) return;
	await signalUntilGone(child, graceMs, initialSignal);
}

/**
 * Stop a process group this invocation did not spawn: an app or a run from
 * the registry, a worker another run claimed. The group, not the pid: a dev
 * command is usually a shell that spawns the real server, and the server
 * keeps the port when only the shell is gone.
 *
 * Returns false, signalling nothing, when `pid` is no longer the process
 * `identity` names (it exited, or the pid was reused).
 */
export async function terminateProcessGroup(
	pid: number,
	identity: string,
	graceMs = 5000,
): Promise<boolean> {
	if (!(await matchesProcessIdentityAsync(pid, identity))) return false;
	await signalUntilGone(new DetachedApp(pid, identity), graceMs, "SIGTERM");
	return true;
}
