import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	EVENT_LOG_LIMIT,
	explainContainerLoss,
	explainServiceStop,
	findRemoval,
	getEventLogFile,
	invocationCommand,
	type RemovalRecord,
	type RunStopRecord,
	readRemovals,
	readRunStops,
	recentRunStops,
	recordEvents,
	runStopRecord,
} from "./removal-log";

// The test preload gives the run a temporary HOME, so this is not the real log.
afterEach(() => rmSync(getEventLogFile(), { force: true }));

const WATCHDOG = {
	command: "buncargo watchdog",
	pid: 4242,
	user: "ci",
	version: "12.4.0",
};

function record(
	extra: Partial<Omit<RemovalRecord, "kind">> = {},
): RemovalRecord {
	return {
		kind: "containers",
		at: "2026-10-17T10:00:00.000Z",
		projectName: "shop-ci",
		root: "/work/shop",
		runtime: "docker",
		reason: "owner gone for 16s",
		by: WATCHDOG,
		...extra,
	};
}

const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const HOUR = 60 * 60_000;

function runStop(root: string, at: number): RunStopRecord {
	return runStopRecord(
		{
			sessionId: `s-${root}-${at}`,
			projectName: "demo",
			root,
			worktree: null,
			pid: 42,
		},
		{
			at: new Date(at).toISOString(),
			reason: "idle",
			detail: "idle for 2h 0m",
		},
	);
}

describe("invocationCommand", () => {
	it("names a CLI command as it was typed, from source or the build", () => {
		expect(
			invocationCommand(["bun", "/pkg/dist/cli/bin.js", "dev", "--down"]),
		).toBe("buncargo dev --down");
		expect(invocationCommand(["bun", "/pkg/src/cli/bin.ts", "ls"])).toBe(
			"buncargo ls",
		);
		expect(invocationCommand(["bun", "/usr/local/bin/buncargo", "ci"])).toBe(
			"buncargo ci",
		);
	});

	it("names a library caller by its script", () => {
		expect(invocationCommand(["bun", "/repo/scripts/e2e.ts"])).toBe(
			"e2e.ts (library)",
		);
		// A `bin.ts` of the user's own is not buncargo's CLI.
		expect(invocationCommand(["bun", "/repo/tools/bin.ts"])).toBe(
			"bin.ts (library)",
		);
	});
});

describe("recordEvents", () => {
	it("keeps removals and run stops in one log, newest only", async () => {
		await recordEvents([record({ reason: "first" }), runStop("/repo", NOW)]);
		await recordEvents(
			Array.from({ length: EVENT_LOG_LIMIT - 1 }, (_, index) =>
				record({ reason: `later ${index}` }),
			),
		);
		const removals = readRemovals();
		expect(removals).toHaveLength(EVENT_LOG_LIMIT - 1);
		expect(removals[0]?.reason).toBe("later 0");
		expect(readRunStops()).toEqual([runStop("/repo", NOW)]);

		await recordEvents([record({ reason: "pushes the stop out" })]);
		expect(readRunStops()).toEqual([]);
	});

	it("never throws when the log cannot be written", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-events-"));
		const realHome = process.env.HOME;
		// A home that is a file: the log's directory cannot be made.
		writeFileSync(join(dir, "home"), "");
		process.env.HOME = join(dir, "home");
		try {
			await recordEvents([record()]);
		} finally {
			process.env.HOME = realHome;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("findRemoval", () => {
	it("finds the newest removal of this checkout's project since the claim", () => {
		const records = [
			record({ at: "2026-10-17T09:00:00.000Z", reason: "before the claim" }),
			record({ root: "/work/other", reason: "another checkout" }),
			record({ projectName: "shop", reason: "the dev stack" }),
			record({ reason: "this one" }),
		];
		expect(
			findRemoval(records, {
				projectName: "shop-ci",
				root: "/work/shop",
				since: Date.parse("2026-10-17T09:30:00.000Z"),
			})?.reason,
		).toBe("this one");
	});
});

describe("explainContainerLoss", () => {
	const target = {
		projectName: "shop-ci",
		root: "/work/shop",
		runtime: "docker",
		since: Date.parse("2026-10-17T09:30:00.000Z"),
		now: Date.parse("2026-10-17T10:05:00.000Z"),
	};

	it("says who removed them, from the record", () => {
		expect(explainContainerLoss({ ...target, records: [record()] })).toBe(
			"buncargo's watchdog (pid 4242, user ci, buncargo 12.4.0) removed shop-ci's containers at 2026-10-17T10:00:00.000Z: owner gone for 16s",
		);
		expect(
			explainContainerLoss({
				...target,
				records: [
					record({
						by: { command: "buncargo dev --down", pid: 9, user: "dev" },
					}),
				],
			}),
		).toBe(
			"`buncargo dev --down` (pid 9, user dev, buncargo of unknown version) removed shop-ci's containers at 2026-10-17T10:00:00.000Z: owner gone for 16s",
		);
	});

	it("names the window and where to look when nothing here recorded it", () => {
		expect(explainContainerLoss({ ...target, records: [] })).toBe(
			"shop-ci's containers were removed outside this run between 2026-10-17T09:30:00.000Z and 2026-10-17T10:05:00.000Z, and this user's buncargo recorded no removal. Check other users' ~/.buncargo/watchdog.log and `docker events --since 2026-10-17T09:30:00.000Z --until 2026-10-17T10:05:00.000Z --filter label=com.docker.compose.project=shop-ci`.",
		);
	});
});

describe("explainServiceStop", () => {
	const target = {
		projectName: "shop-ci",
		root: "/work/shop",
		runtime: "docker",
		service: "postgres",
		since: Date.parse("2026-10-17T09:30:00.000Z"),
	};
	const stop = {
		...record({
			reason: "stopped",
			by: { command: "buncargo stop postgres", pid: 9, user: "dev" },
		}),
		kind: "services" as const,
		services: ["postgres"],
	};

	it("names the command that stopped that service, or the whole stack", () => {
		expect(explainServiceStop({ ...target, records: [stop] })).toBe(
			"`buncargo stop postgres` (pid 9, user dev, buncargo of unknown version) stopped shop-ci's postgres container at 2026-10-17T10:00:00.000Z: stopped",
		);
		expect(explainServiceStop({ ...target, records: [record()] })).toContain(
			"buncargo's watchdog",
		);
	});

	it("names what ran the command, so a menu bar button reads apart from a terminal", () => {
		expect(
			explainServiceStop({
				...target,
				records: [
					{
						...stop,
						by: {
							...stop.by,
							command: "buncargo stop --all",
							parent: "BuncargoBar",
						},
					},
				],
			}),
		).toContain(
			"(pid 9, user dev, buncargo of unknown version, run from BuncargoBar)",
		);
	});

	it("ignores another service's stop and anything before the run, and says where to look", () => {
		const explained = explainServiceStop({
			...target,
			records: [
				{ ...stop, services: ["redis"] },
				record({ at: "2026-10-17T09:00:00.000Z" }),
			],
		});
		expect(explained).toContain("No buncargo command of this user stopped it");
		expect(explained).toContain(
			"docker events --since 2026-10-17T09:30:00.000Z --filter label=com.docker.compose.project=shop-ci",
		);
	});
});

describe("recentRunStops", () => {
	it("reports the newest stop of each checkout from the last day", () => {
		const records = [
			runStop("/old", NOW - 25 * HOUR),
			runStop("/repo", NOW - 3 * HOUR),
			runStop("/repo", NOW - HOUR),
		];
		expect(recentRunStops(records, [], NOW)).toEqual([records[2]]);
	});

	it("drops a stop once a run has started in that checkout since", () => {
		const records = [runStop("/repo", NOW - HOUR)];
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
