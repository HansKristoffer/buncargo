import { typedSwitch } from "hanzio";
import { abortableSleep } from "../deadline";
import {
	checkProcessIdentityAsync,
	type ProcessIdentityCheck,
} from "../process-identity";
import { formatWarn } from "../style";
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
async function stillOurs(
	child: AppChild | DetachedApp,
): Promise<ProcessIdentityCheck> {
	if (!(child instanceof DetachedApp)) return "match";
	if (!isProcessAlive(child.pid)) return "match";
	return checkProcessIdentityAsync(child.pid, child.identity);
}

/**
 * A process that may still run, but whose identity could not be read to
 * confirm it is the recorded one, so it was not sent `signal`. Never reads as
 * "already gone": the caller must not report it stopped.
 */
export class ProcessIdentityUnreadable extends Error {
	constructor(
		readonly pid: number,
		readonly signal: NodeJS.Signals,
	) {
		super(
			signal === "SIGKILL"
				? `pid ${pid} is still running after SIGTERM, and its identity could not be read to confirm it before SIGKILL`
				: `pid ${pid}'s identity could not be read to confirm it is still the recorded process; nothing was signalled`,
		);
	}
}

/**
 * Whether to go on and send `signal`: false when `pid` is no longer ours.
 * Throws {@link ProcessIdentityUnreadable} when that cannot be read.
 */
function confirmedOurs(
	check: ProcessIdentityCheck,
	pid: number,
	signal: NodeJS.Signals,
): boolean {
	return typedSwitch(check, {
		match: () => true,
		mismatch: () => false,
		unreadable: () => {
			throw new ProcessIdentityUnreadable(pid, signal);
		},
	});
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
	if (!ownedProcessAlive(child)) return;
	const ours = await stillOurs(child);
	if (!confirmedOurs(ours, child.pid ?? 0, "SIGKILL")) return;
	signalGroup(child, "SIGKILL");
	const killDeadline = performance.now() + 1000;
	while (ownedProcessAlive(child) && performance.now() < killDeadline)
		await abortableSleep(25);
	if (ownedProcessAlive(child))
		throw new Error(`Process group ${child.pid} did not exit after SIGKILL`);
}

/** How long a process gets after SIGTERM before SIGKILL, unless it sets `stopGraceMs`. */
export const DEFAULT_STOP_GRACE_MS = 5000;

/**
 * Only for children spawned detached by this invocation, never reused ports.
 *
 * An adopted app whose identity cannot be read is left alone with a warning:
 * signalling it could hit an unrelated process, and staying silent would let
 * the run report it stopped.
 */
export async function terminateOwnedProcess(
	child: AppChild | DetachedApp,
	graceMs = DEFAULT_STOP_GRACE_MS,
	initialSignal: NodeJS.Signals = "SIGTERM",
): Promise<void> {
	try {
		if (!ownedProcessAlive(child)) return;
		const ours = await stillOurs(child);
		if (!confirmedOurs(ours, child.pid ?? 0, initialSignal)) return;
		await signalUntilGone(child, graceMs, initialSignal);
	} catch (error) {
		if (!(error instanceof ProcessIdentityUnreadable)) throw error;
		console.warn(
			formatWarn(
				`${error.message}. Check it with \`ps -p ${error.pid}\` and stop it yourself if it is still the app.`,
			),
		);
	}
}

/**
 * Stop a process group this invocation did not spawn: an app or a run from
 * the registry, a worker another run claimed. The group, not the pid: a dev
 * command is usually a shell that spawns the real server, and the server
 * keeps the port when only the shell is gone.
 *
 * Returns false, signalling nothing, when `pid` is no longer the process
 * `identity` names (it exited, or the pid was reused). Throws
 * {@link ProcessIdentityUnreadable} when that cannot be read, before the
 * first signal or before SIGKILL.
 */
export async function terminateProcessGroup(
	pid: number,
	identity: string,
	graceMs = DEFAULT_STOP_GRACE_MS,
): Promise<boolean> {
	const check = await checkProcessIdentityAsync(pid, identity);
	if (!confirmedOurs(check, pid, "SIGTERM")) return false;
	await signalUntilGone(new DetachedApp(pid, identity), graceMs, "SIGTERM");
	return true;
}
