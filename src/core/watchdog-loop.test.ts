import { describe, expect, it } from "bun:test";
import type { SweepResult } from "../container-runtime/sweep";
import { exitUnlessClaimed, runWatchdogLoop } from "./watchdog-loop";

function pass(extra: Partial<SweepResult> = {}): SweepResult {
	return {
		swept: [],
		failed: [],
		containers: 1,
		liveRuns: 1,
		pendingStacks: 0,
		answered: ["docker"],
		remaining: [],
		runs: [],
		liveSessions: new Set(),
		...extra,
	};
}

/**
 * Run the loop over a scripted list of passes; a string throws. `exits` answers
 * each idle pass in turn, and an idle pass past its end exits.
 */
async function loop(
	script: Array<SweepResult | string>,
	exits: boolean[] = [],
): Promise<string[]> {
	const logs: string[] = [];
	const passes = [...script];
	const answers = [...exits];
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
		exitIfIdle: async () => answers.shift() ?? true,
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

	it("keeps watching while a released run's stack waits for its hold", async () => {
		// No containers of ours and no live run, but a Supabase stack the
		// sweep still has to stop once the hold runs out.
		const stopped = {
			projectName: "demo",
			root: "/repo",
			runtime: "supabase",
			reason: "released 200s ago",
		};
		const logs = await loop([
			pass({ containers: 0, liveRuns: 0, pendingStacks: 1 }),
			pass({ containers: 0, liveRuns: 0, swept: [stopped] }),
		]);
		expect(logs).toEqual([
			"Removed demo (/repo): released 200s ago",
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

	it("keeps watching when a run claims while it is exiting", async () => {
		// A run that claimed after the pass read the registry found this
		// runner still up, so it started none, and the runner then left.
		const logs = await loop(
			[
				pass({ containers: 0, liveRuns: 0 }),
				pass({ containers: 0, liveRuns: 1 }),
				pass({ containers: 0, liveRuns: 0 }),
			],
			[false],
		);
		expect(logs).toEqual([
			"A run claimed while exiting; still watching",
			"Nothing left to watch; exiting",
		]);
	});
});

describe("exitUnlessClaimed", () => {
	function exit(liveRuns: () => Promise<boolean>) {
		const events: string[] = [];
		let held = false;
		const decided = exitUnlessClaimed({
			withSpawnLock: async (operation) => {
				held = true;
				events.push("lock");
				try {
					await operation();
				} finally {
					held = false;
					events.push("unlock");
				}
			},
			removePidFile: () => events.push("remove pid"),
			restorePidFile: () => events.push("restore pid"),
			hasLiveRuns: async () => {
				events.push("read runs");
				return liveRuns();
			},
		});
		return { decided, events, held: () => held };
	}

	it("reads the registry after the pid file is gone, and keeps the spawn lock to exit", async () => {
		// With the pid file gone before the read, a run claiming later finds
		// no watchdog and waits on the spawn lock for this one to be gone.
		const { decided, events, held } = exit(async () => false);
		expect(await decided).toBe(true);
		expect(events).toEqual(["lock", "remove pid", "read runs"]);
		expect(held()).toBe(true);
	});

	it("puts the pid file back before releasing the lock when a run claimed", async () => {
		const { decided, events, held } = exit(async () => true);
		expect(await decided).toBe(false);
		expect(events).toEqual([
			"lock",
			"remove pid",
			"read runs",
			"restore pid",
			"unlock",
		]);
		expect(held()).toBe(false);
	});

	it("keeps watching when the registry cannot be read", async () => {
		const { decided, events } = exit(async () => {
			throw new Error("runs.json is mid-write");
		});
		expect(await decided).toBe(false);
		expect(events).toContain("restore pid");
	});

	it("rejects without touching the pid file when the lock is busy", async () => {
		const events: string[] = [];
		const decided = exitUnlessClaimed({
			withSpawnLock: async () => {
				throw new Error("spawn lock busy");
			},
			removePidFile: () => events.push("remove pid"),
			restorePidFile: () => events.push("restore pid"),
			hasLiveRuns: async () => false,
		});
		await expect(decided).rejects.toThrow("spawn lock busy");
		expect(events).toEqual([]);
	});
});
