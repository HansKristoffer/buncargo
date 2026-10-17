import { describe, expect, it } from "bun:test";
import type { SweepResult } from "../container-runtime/sweep";
import type { RunEntry } from "./run-registry";
import {
	claimedSincePass,
	describeSwept,
	exitUnlessClaimed,
	formatWatchdogLine,
	runWatchdogLoop,
} from "./watchdog-loop";

function pass(extra: Partial<SweepResult> = {}): SweepResult {
	return {
		swept: [],
		failed: [],
		containers: 1,
		liveRuns: 1,
		pendingStacks: 0,
		answered: ["docker"],
		remaining: [],
		foreign: [],
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
	it("stops without sweeping once its state directory is gone", async () => {
		// A watchdog a test started outlived the test's temporary HOME and,
		// with no registry left to name a stack, swept real ones.
		const logs: string[] = [];
		let sweeps = 0;
		await runWatchdogLoop({
			sweep: async () => {
				sweeps += 1;
				return sweeps < 3 ? pass() : pass({ containers: 0, liveRuns: 0 });
			},
			sleep: async () => {},
			log: (message) => logs.push(message),
			intervalMs: 0,
			exitIfIdle: async () => true,
			stateGone: () => sweeps === 2,
		});
		expect(sweeps).toBe(2);
		expect(logs).toEqual(["The state directory is gone; exiting"]);
	});

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
			"Removed demo's containers (/repo, supabase): released 200s ago; its run: none on record",
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
			"Removed demo's containers (/repo, docker): checkout deleted; its run: none on record",
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

describe("formatWatchdogLine", () => {
	it("names the watchdog's version and pid on every line", () => {
		// One watchdog sweeps for every checkout, whichever buncargo started
		// it; a line read on its own has to say which one did this.
		const at = new Date("2026-10-17T10:00:00.000Z");
		expect(
			formatWatchdogLine({ pid: 4242, version: "12.4.0" }, at, "Started"),
		).toBe("[watchdog 12.4.0 pid 4242] 2026-10-17T10:00:00.000Z Started");
		expect(formatWatchdogLine({ pid: 7 }, at, "Started")).toBe(
			"[watchdog unknown version pid 7] 2026-10-17T10:00:00.000Z Started",
		);
	});
});

describe("describeSwept", () => {
	it("names the run a removal was decided against", () => {
		expect(
			describeSwept({
				projectName: "shop",
				root: "/work/shop-feature",
				runtime: "docker",
				reason: "owner gone for 16s",
				owner: {
					sessionId: "s1",
					pid: 4242,
					worktree: "feature",
					branch: "feature/login",
				},
			}),
		).toBe(
			"Removed shop's containers (/work/shop-feature, docker): owner gone for 16s; its run: session s1, pid 4242, worktree feature, branch feature/login",
		);
	});

	it("says when no run is on record, and names removed volumes", () => {
		expect(
			describeSwept({
				projectName: "shop",
				root: "/gone",
				runtime: "docker",
				reason: "checkout deleted, removed volumes shop_db",
				volumes: ["shop_db"],
			}),
		).toBe(
			"Removed shop's volumes shop_db (/gone, docker): checkout deleted, removed volumes shop_db; its run: none on record",
		);
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

describe("claimedSincePass", () => {
	const run = (sessionId: string, released = false) =>
		({
			sessionId,
			releasedAt: released ? "2026-10-17T00:00:00.000Z" : undefined,
		}) as RunEntry;
	const alive = (entry: RunEntry) => entry.releasedAt === undefined;

	it("stays for a run that claimed after the pass and has already released", () => {
		// Released, so not live; but its containers were not in the pass.
		expect(
			claimedSincePass(pass({ runs: [] }), [run("late", true)], alive),
		).toBe(true);
	});

	it("stays for a live run, and exits when every entry was the pass's and none is live", () => {
		const earlier = run("earlier", true);
		expect(
			claimedSincePass(pass({ runs: [earlier] }), [run("earlier")], alive),
		).toBe(true);
		expect(claimedSincePass(pass({ runs: [earlier] }), [earlier], alive)).toBe(
			false,
		);
		expect(claimedSincePass(pass({ runs: [earlier] }), [], alive)).toBe(false);
	});
});
