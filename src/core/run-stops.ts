/**
 * The detached runs the watchdog stopped, and why, so `stop` and `ls` can say
 * it after the run's entry is gone.
 *
 * A run's entry does not outlive it: releasing withdraws an app-only run's
 * entry at once, and the sweep retires the rest once their containers are
 * gone. Without this record, "where did my run go?" had no answer but the
 * watchdog's log. Per user, newest {@link RUN_STOPS_LIMIT}, rewritten whole
 * under its file lock, like the removal log.
 */

import { withFileLock } from "./file-lock";
import { readJsonDocumentSync, writeJsonDocument } from "./registry-file";
import type { RunEntry } from "./run-registry";
import { chownToInvokingUser, stateFilePath } from "./state-paths";

export const RUN_STOPS_LIMIT = 200;

/** How far back `stop` and `ls` report a stop. */
const RECENT_MS = 24 * 60 * 60_000;

export type RunStopReason = "idle" | "checkout deleted";

export interface RunStopRecord {
	at: string;
	reason: RunStopReason;
	/** The sentence `stop` and `ls` print: "idle for 2h 0m (…)". */
	detail: string;
	sessionId: string;
	projectName: string;
	root: string;
	worktree: string | null;
	pid: number;
}

export function getRunStopsFile(): string {
	return stateFilePath("run-stops.json");
}

/** The record of one stopped run, from its entry. */
export function runStopRecord(
	run: RunEntry,
	stop: { at: string; reason: RunStopReason; detail: string },
): RunStopRecord {
	return {
		...stop,
		sessionId: run.sessionId,
		projectName: run.projectName,
		root: run.root,
		worktree: run.worktree,
		pid: run.pid,
	};
}

function isRunStopRecord(value: unknown): value is RunStopRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<RunStopRecord>;
	return (
		typeof record.at === "string" &&
		(record.reason === "idle" || record.reason === "checkout deleted") &&
		typeof record.detail === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.projectName === "string" &&
		typeof record.root === "string" &&
		typeof record.pid === "number"
	);
}

function validate(value: unknown): RunStopRecord[] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const stops = (value as { stops?: unknown }).stops;
	return Array.isArray(stops) ? stops.filter(isRunStopRecord) : undefined;
}

export function readRunStops(): RunStopRecord[] {
	return readJsonDocumentSync(getRunStopsFile(), validate) ?? [];
}

/**
 * Append records, keeping the newest {@link RUN_STOPS_LIMIT}. Never throws:
 * the run is stopped either way, only its explanation is lost.
 */
export async function recordRunStops(
	records: readonly RunStopRecord[],
): Promise<void> {
	if (records.length === 0) return;
	const file = getRunStopsFile();
	try {
		await withFileLock(file, async () => {
			const stops = [...readRunStops(), ...records].slice(-RUN_STOPS_LIMIT);
			await writeJsonDocument(
				file,
				{ version: 1, stops },
				{ afterWrite: chownToInvokingUser },
			);
		});
	} catch {
		// The run is stopped; only why is lost.
	}
}

/**
 * The stops still worth reporting: of the last day, the newest per
 * checkout, and only where no run on record has started since (that run is
 * the news now).
 */
export function recentRunStops(
	records: readonly RunStopRecord[],
	runs: readonly Pick<RunEntry, "root" | "startedAt">[],
	now: number,
): RunStopRecord[] {
	const newest = new Map<string, RunStopRecord>();
	for (const record of records) {
		const at = Date.parse(record.at);
		const recent = !Number.isNaN(at) && now - at < RECENT_MS;
		const restarted = runs.some(
			(run) => run.root === record.root && Date.parse(run.startedAt) > at,
		);
		if (recent && !restarted) newest.set(record.root, record);
		else if (restarted) newest.delete(record.root);
	}
	return [...newest.values()];
}

/** "The watchdog stopped demo's detached run at …: idle for 2h 0m (…)." */
export function describeRunStop(record: RunStopRecord): string {
	return `buncargo's watchdog stopped ${record.projectName}'s detached run (pid ${record.pid}) at ${record.at}: ${record.detail}.`;
}
