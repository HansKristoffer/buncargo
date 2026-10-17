import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	explainContainerLoss,
	findRemoval,
	invocationCommand,
	REMOVAL_LOG_LIMIT,
	type RemovalRecord,
	readRemovals,
	recordRemovals,
} from "./removal-log";

const dir = mkdtempSync(join(tmpdir(), "buncargo-removals-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const WATCHDOG = {
	command: "buncargo watchdog",
	pid: 4242,
	user: "ci",
	version: "12.4.0",
};

function record(extra: Partial<RemovalRecord> = {}): RemovalRecord {
	return {
		at: "2026-10-17T10:00:00.000Z",
		projectName: "shop-ci",
		root: "/work/shop",
		runtime: "docker",
		reason: "owner gone for 16s",
		by: WATCHDOG,
		...extra,
	};
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

describe("recordRemovals", () => {
	it("appends and keeps only the newest records", async () => {
		const file = join(dir, "removals.json");
		await recordRemovals([record({ reason: "first" })], file);
		await recordRemovals(
			Array.from({ length: REMOVAL_LOG_LIMIT }, (_, index) =>
				record({ reason: `later ${index}` }),
			),
			file,
		);
		const removals = readRemovals(file);
		expect(removals).toHaveLength(REMOVAL_LOG_LIMIT);
		expect(removals[0]?.reason).toBe("later 0");
		expect(removals.at(-1)?.reason).toBe(`later ${REMOVAL_LOG_LIMIT - 1}`);
	});

	it("never throws when the log cannot be written", async () => {
		await recordRemovals(
			[record()],
			join(dir, "not-a-dir", "\0", "removals.json"),
		);
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
