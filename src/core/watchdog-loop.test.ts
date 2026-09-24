import { describe, expect, it } from "bun:test";
import type { SweepResult } from "../container-runtime/sweep";
import { runWatchdogLoop } from "./watchdog-loop";

function pass(extra: Partial<SweepResult> = {}): SweepResult {
	return {
		swept: [],
		failed: [],
		containers: 1,
		liveRuns: 1,
		answered: ["docker"],
		remaining: [],
		runs: [],
		liveSessions: new Set(),
		...extra,
	};
}

/** Run the loop over a scripted list of passes; a string throws. */
async function loop(script: Array<SweepResult | string>): Promise<string[]> {
	const logs: string[] = [];
	const passes = [...script];
	await runWatchdogLoop({
		sweep: async () => {
			const next = passes.shift();
			if (next === undefined) throw new Error("script ran out");
			if (typeof next === "string") throw new Error(next);
			return next;
		},
		sleep: async () => {},
		log: (message) => logs.push(message),
		intervalMs: 0,
	});
	return logs;
}

const failed = (error: string) => ({
	failed: [{ projectName: "demo", root: "/repo", error }],
});

describe("runWatchdogLoop", () => {
	it("survives a pass that throws, and keeps sweeping", async () => {
		// The runner used to exit here, leaving nothing to sweep until the
		// next buncargo command.
		const logs = await loop([
			"runs.json could not be read",
			pass(),
			pass({ containers: 0, liveRuns: 0 }),
		]);
		expect(logs).toEqual([
			"Sweep failed, retrying next pass: runs.json could not be read",
			"Nothing left to watch; exiting",
		]);
	});

	it("logs a failure once until it changes", async () => {
		const logs = await loop([
			"lock busy",
			"lock busy",
			pass(failed("daemon restarting")),
			pass(failed("daemon restarting")),
			pass(failed("permission denied")),
			pass({ containers: 0, liveRuns: 0 }),
		]);
		expect(logs).toEqual([
			"Sweep failed, retrying next pass: lock busy",
			"Could not remove demo: daemon restarting",
			"Could not remove demo: permission denied",
			"Nothing left to watch; exiting",
		]);
	});

	it("reports what it removed and exits only when nothing is left", async () => {
		const logs = await loop([
			pass({
				swept: [
					{
						projectName: "demo",
						root: "/repo",
						runtime: "docker",
						reason: "checkout deleted",
					},
				],
			}),
			pass({ containers: 0, liveRuns: 1 }),
			pass({ containers: 0, liveRuns: 0 }),
		]);
		expect(logs).toEqual([
			"Removed demo (/repo): checkout deleted",
			"Nothing left to watch; exiting",
		]);
	});
});
