/**
 * Detached runs that end: the watchdog stops a `dev --detach` run nobody is
 * using, and one whose checkout was deleted.
 *
 * A detached run sits in its own session and, on Linux, its own systemd
 * scope, so nothing that started it can end it: the agent's harness cannot,
 * and a closed terminal does not. On one machine 13 of them were found 1 to
 * 16 days old, several serving worktrees that no longer existed, because the
 * sweep keeps a live owner's stack before it looks at the checkout.
 *
 * Only an entry marked `detached` is a candidate: a run in a terminal is
 * someone's, and is never stopped here. Stopping is what `stop --all` does to
 * the run's process (SIGTERM to its group, by the recorded pid and only after
 * its identity matches), so the run tears itself down and releases its
 * containers to the hold, where the sweep takes them as for any ended run.
 */

import { getErrorMessage, typedSwitch } from "hanzio";
import type { CheckoutPresence } from "./checkout-presence";
import type { ProxyActivity } from "./hosts/proxy-activity";
import { runStopGraceMs, terminateProcessGroup } from "./process/terminate";
import { lastCheckoutCommandAt } from "./run-activity";
import type { RunEntry } from "./run-registry";
import type { RunStopReason, RunStopRecord } from "./run-stops";
import { runStopRecord } from "./run-stops";
import { DELETED_CHECKOUT_SETTLE_MS } from "./watchdog-constants";

/** Where a detached run stands against its idle limit. */
export type IdleState =
	/** No limit: a run in a terminal, `--keep`, or an older buncargo's run. */
	| { kind: "off" }
	/** A limit that cannot be judged, so it is not enforced. */
	| { kind: "unknown"; why: string }
	| { kind: "counting"; lastActivityAt: number; stopsAt: number };

export interface RunActivity {
	/** When a buncargo command last ran in the checkout (`run-activity.ts`). */
	commandAt: number | undefined;
	/**
	 * Last request through the proxy by checkout, or `undefined` when no
	 * hosts daemon on this machine records them (`hosts/proxy-activity.ts`).
	 */
	proxy: ProxyActivity | undefined;
}

/** The idle limit of one run, from its entry and what was read of its use. */
export function idleState(
	run: Pick<
		RunEntry,
		"detached" | "idleLimitMs" | "startedAt" | "hosts" | "root"
	>,
	activity: RunActivity,
): IdleState {
	if (!run.detached || run.idleLimitMs === undefined) return { kind: "off" };
	// Requests are the run being used; with nothing counting them, a quiet
	// limit would stop a run someone has open in a browser.
	if (run.hosts?.active && activity.proxy === undefined)
		return {
			kind: "unknown",
			why: "the hosts daemon predates request counting; `buncargo hosts install` updates it",
		};
	const times = [
		Date.parse(run.startedAt),
		activity.commandAt,
		activity.proxy?.get(run.root),
	].filter((time): time is number => time !== undefined && !Number.isNaN(time));
	if (times.length === 0)
		return { kind: "unknown", why: "its start time does not parse" };
	const lastActivityAt = Math.max(...times);
	return {
		kind: "counting",
		lastActivityAt,
		stopsAt: lastActivityAt + run.idleLimitMs,
	};
}

/** A run's idle limit as a reader shows it, read from the disk now. */
export function readIdleState(
	run: RunEntry,
	proxy: ProxyActivity | undefined,
): IdleState {
	return idleState(run, { commandAt: lastCheckoutCommandAt(run.root), proxy });
}

/** "stops after 1h 42m more idle", or why the limit is not enforced. */
export function describeIdleState(
	state: IdleState,
	now: number,
): string | undefined {
	return typedSwitch(state, "kind", {
		off: () => undefined,
		unknown: ({ why }) => `idle limit not enforced: ${why}`,
		counting: ({ stopsAt }) =>
			now < stopsAt
				? `stops after ${formatDuration(stopsAt - now)} more with no request or buncargo command`
				: "idle past its limit; the watchdog stops it on its next pass",
	});
}

export type RunLimitVerdict =
	{ kind: "keep" } | { kind: "stop"; reason: RunStopReason; detail: string };

/** "2h 0m", "14m". */
export function formatDuration(ms: number): string {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	const hours = Math.floor(minutes / 60);
	return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * Whether the watchdog stops a run. Pure, so the policy is tested without
 * processes or hours of waiting.
 */
export function decideRunLimit(input: {
	run: Pick<RunEntry, "detached" | "root">;
	alive: boolean;
	/**
	 * A live run in a terminal uses the same checkout: it may be serving
	 * from this run's apps (`port-reuse.ts`), whatever reaches the proxy.
	 */
	sharedWithTerminalRun: boolean;
	checkout: CheckoutPresence;
	/** When the watchdog first found the checkout deleted, this time round. */
	deletedSince: number | undefined;
	idle: IdleState;
	now: number;
}): RunLimitVerdict {
	const { run, alive, checkout, deletedSince, idle, now } = input;
	if (!alive || !run.detached) return { kind: "keep" };
	// Stopping this run would take apps from under the other one.
	if (input.sharedWithTerminalRun) return { kind: "keep" };

	// Seen deleted on two passes this far apart, like a deleted checkout's
	// volumes: a worktree being recreated, or a disk briefly gone, costs
	// nothing.
	const deletedFor =
		checkout === "deleted" && deletedSince !== undefined
			? now - deletedSince
			: undefined;
	if (deletedFor !== undefined && deletedFor >= DELETED_CHECKOUT_SETTLE_MS)
		return {
			kind: "stop",
			reason: "checkout deleted",
			detail: `its checkout ${run.root} has been deleted for ${formatDuration(deletedFor)}`,
		};

	if (idle.kind === "counting" && now >= idle.stopsAt)
		return {
			kind: "stop",
			reason: "idle",
			detail: `idle for ${formatDuration(now - idle.lastActivityAt)}, with no request through buncargo's proxy and no buncargo command in ${run.root} (\`dev --detach --keep\` opts out)`,
		};
	return { kind: "keep" };
}

/**
 * End a run's process the way `stop --all` does: SIGTERM to its group, by
 * the recorded pid and only while it is still the recorded process, SIGKILL
 * after the run's stop grace. False when there is no identity to match or the
 * process is gone.
 */
export async function terminateRun(run: RunEntry): Promise<boolean> {
	if (run.processIdentity === undefined) return false;
	return terminateProcessGroup(
		run.pid,
		run.processIdentity,
		runStopGraceMs(run),
	);
}

export interface RunLimiterDeps {
	readRuns: () => Promise<RunEntry[]>;
	liveness: (runs: readonly RunEntry[]) => Promise<(run: RunEntry) => boolean>;
	checkoutPresence: (root: string) => CheckoutPresence;
	lastCommandAt: (root: string) => number | undefined;
	readProxyActivity: (now: number) => ProxyActivity | undefined;
	/**
	 * End the run's process by its recorded pid and identity; false when it
	 * was already gone or is no longer that process. Throws when it could not
	 * be told.
	 */
	stopRun: (run: RunEntry) => Promise<boolean>;
	recordStops: (records: readonly RunStopRecord[]) => Promise<void>;
	now: () => number;
}

export interface RunLimitPass {
	/** One line per run stopped, for the watchdog's log. */
	stopped: string[];
	/** Runs that should have stopped and could not be; logged once by the loop. */
	failures: string[];
}

/**
 * One watchdog pass over the detached runs. Stateful only in when each
 * checkout was first seen deleted, which a replaced watchdog forgets: that
 * costs one more settle period, never an early stop.
 */
export function createRunLimiter(
	deps: RunLimiterDeps,
): () => Promise<RunLimitPass> {
	const deletedSince = new Map<string, number>();

	return async () => {
		const all = (await deps.readRuns()).filter(
			(run) => run.releasedAt === undefined,
		);
		const runs = all.filter((run) => run.detached);
		const now = deps.now();
		for (const session of deletedSince.keys())
			if (!runs.some((run) => run.sessionId === session))
				deletedSince.delete(session);
		// Without a detached run, nothing to fork `ps` for.
		if (runs.length === 0) return { stopped: [], failures: [] };

		// The detached runs, and the terminal runs in their checkouts.
		const roots = new Set(runs.map((run) => run.root));
		const terminalRuns = all.filter(
			(run) => !run.detached && roots.has(run.root),
		);
		const alive = await deps.liveness([...runs, ...terminalRuns]);
		const proxy = deps.readProxyActivity(now);
		const due: Array<{ run: RunEntry; reason: RunStopReason; detail: string }> =
			[];
		for (const run of runs) {
			const checkout = deps.checkoutPresence(run.root);
			if (checkout !== "deleted") deletedSince.delete(run.sessionId);
			else if (!deletedSince.has(run.sessionId))
				deletedSince.set(run.sessionId, now);
			const verdict = decideRunLimit({
				run,
				alive: alive(run),
				sharedWithTerminalRun: terminalRuns.some(
					(other) => other.root === run.root && alive(other),
				),
				checkout,
				deletedSince: deletedSince.get(run.sessionId),
				idle: idleState(run, {
					commandAt: deps.lastCommandAt(run.root),
					proxy,
				}),
				now,
			});
			if (verdict.kind === "stop") due.push({ run, ...verdict });
		}

		const pass: RunLimitPass = { stopped: [], failures: [] };
		const records: RunStopRecord[] = [];
		await Promise.all(
			due.map(async ({ run, reason, detail }) => {
				const what = `${run.projectName}'s detached run (${run.root}, pid ${run.pid})`;
				try {
					if (!(await deps.stopRun(run))) return;
				} catch (error) {
					pass.failures.push(
						`Could not stop ${what}: ${getErrorMessage(error)}`,
					);
					return;
				}
				const at = new Date(deps.now()).toISOString();
				pass.stopped.push(`Stopped ${what}: ${detail}`);
				records.push(runStopRecord(run, { at, reason, detail }));
			}),
		);
		await deps.recordStops(records);
		return pass;
	};
}
