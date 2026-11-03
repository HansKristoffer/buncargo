import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import type { RunEntry } from "./run-registry";
import {
	getRunStopsFile,
	RUN_STOPS_LIMIT,
	type RunStopRecord,
	readRunStops,
	recentRunStops,
	recordRunStops,
	runStopRecord,
} from "./run-stops";

// The test preload gives the run a temporary HOME, so this is not the real file.
afterEach(() => rmSync(getRunStopsFile(), { force: true }));

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60_000;

function stop(root: string, at: number): RunStopRecord {
	return runStopRecord(
		{
			sessionId: `s-${root}-${at}`,
			projectName: "demo",
			root,
			worktree: null,
			pid: 42,
		} as RunEntry,
		{
			at: new Date(at).toISOString(),
			reason: "idle",
			detail: "idle for 2h 0m",
		},
	);
}

describe("recordRunStops", () => {
	it("keeps the newest records only", async () => {
		const many = Array.from({ length: RUN_STOPS_LIMIT + 5 }, (_, index) =>
			stop("/repo", NOW + index),
		);
		await recordRunStops(many);
		const kept = readRunStops();
		expect(kept).toHaveLength(RUN_STOPS_LIMIT);
		expect(kept[0]?.at).toBe(new Date(NOW + 5).toISOString());
	});
});

describe("recentRunStops", () => {
	it("reports the newest stop of each checkout from the last day", () => {
		const records = [
			stop("/old", NOW - 25 * HOUR),
			stop("/repo", NOW - 3 * HOUR),
			stop("/repo", NOW - HOUR),
		];
		expect(recentRunStops(records, [], NOW)).toEqual([records[2]]);
	});

	it("drops a stop once a run has started in that checkout since", () => {
		const records = [stop("/repo", NOW - HOUR)];
		const restarted = [
			{ root: "/repo", startedAt: new Date(NOW - 10 * 60_000).toISOString() },
		];
		expect(recentRunStops(records, restarted, NOW)).toEqual([]);
		// The run the watchdog stopped started before it, and does not count.
		const stoppedRun = [
			{ root: "/repo", startedAt: new Date(NOW - 5 * HOUR).toISOString() },
		];
		expect(recentRunStops(records, stoppedRun, NOW)).toEqual(records);
	});
});
