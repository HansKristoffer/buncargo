import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimRun,
	groupRunsByProject,
	loadRuns,
	patchRun,
	pruneRuns,
	publishRun,
	type RunEntry,
	withdrawRun,
} from "./run-registry";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "buncargo-runs-"));
	path = join(dir, "runs.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A pid that is certainly not running. */
const DEAD_PID = 2 ** 22;

function makeRun(overrides: Partial<RunEntry> = {}): RunEntry {
	const now = new Date().toISOString();
	return {
		projectPrefix: "lullu",
		projectName: "lullu-lullu",
		root: "/repos/lullu",
		worktree: null,
		pid: process.pid,
		startedAt: now,
		updatedAt: now,
		hosts: null,
		cli: { program: "/bin/bun" },
		apps: [
			{
				name: "api",
				port: 7100,
				url: "http://localhost:7100",
				loopbackUrl: "http://localhost:7100",
				status: "starting",
			},
		],
		services: [],
		...overrides,
	};
}

describe("publishRun", () => {
	it("round-trips an entry", async () => {
		await publishRun(makeRun(), { path });
		const runs = await loadRuns(path);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.projectName).toBe("lullu-lullu");
		expect(runs[0]?.apps[0]?.name).toBe("api");
	});

	// The file carries the dev database password from the compose defaults.
	it("writes the registry unreadable by other users", async () => {
		await publishRun(makeRun(), { path });
		expect(statSync(path).mode & 0o077).toBe(0);
	});

	it("replaces its own earlier entry for the same root", async () => {
		await publishRun(makeRun(), { path });
		await publishRun(makeRun({ projectName: "renamed" }), { path });
		const runs = await loadRuns(path);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.projectName).toBe("renamed");
	});

	// A second `buncargo dev` in the same checkout reuses the first run's
	// servers. The live run stays the owner, so the entry disappears when the
	// process owning those servers exits rather than when a bystander does.
	it("leaves a live run in place when a second one starts in the same root", async () => {
		await publishRun(makeRun({ projectName: "first" }), { path });
		await publishRun(makeRun({ projectName: "second", pid: process.pid + 1 }), {
			path,
		});
		const runs = await loadRuns(path);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.projectName).toBe("first");
	});

	it("takes over a root whose owner is gone", async () => {
		await publishRun(makeRun({ projectName: "dead", pid: DEAD_PID }), { path });
		await publishRun(makeRun({ projectName: "live" }), { path });
		const runs = await loadRuns(path);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.projectName).toBe("live");
	});

	it("keeps runs from different roots side by side", async () => {
		await publishRun(makeRun(), { path });
		await publishRun(
			makeRun({ root: "/repos/geysier", projectName: "geysier" }),
			{ path },
		);
		expect(await loadRuns(path)).toHaveLength(2);
	});
});

describe("claimRun", () => {
	it("refuses a different root", () => {
		const existing = makeRun();
		const incoming = makeRun({ root: "/elsewhere", pid: process.pid + 1 });
		expect(claimRun(existing, incoming)).toBe("conflict");
	});

	it("refreshes the same run", () => {
		expect(claimRun(makeRun(), makeRun())).toBe("take");
	});
});

describe("pruneRuns", () => {
	it("drops entries whose owner died", async () => {
		await publishRun(makeRun({ pid: DEAD_PID }), { path });
		expect(await pruneRuns(path)).toHaveLength(0);
	});

	it("removes the file once nothing is left", async () => {
		await publishRun(makeRun({ pid: DEAD_PID }), { path });
		await pruneRuns(path);
		expect(() => readFileSync(path, "utf-8")).toThrow();
	});
});

describe("patchRun", () => {
	it("updates one app without touching the others", async () => {
		await publishRun(
			makeRun({
				apps: [
					{
						name: "api",
						port: 1,
						url: "u",
						loopbackUrl: "u",
						status: "starting",
					},
					{
						name: "web",
						port: 2,
						url: "u",
						loopbackUrl: "u",
						status: "starting",
					},
				],
			}),
			{ path },
		);
		await patchRun(
			"/repos/lullu",
			process.pid,
			{ apps: [{ name: "api", status: "ready", pid: 42 }] },
			{ path },
		);
		const runs = await loadRuns(path);
		expect(runs[0]?.apps[0]).toMatchObject({ status: "ready", pid: 42 });
		expect(runs[0]?.apps[1]?.status).toBe("starting");
	});

	// A taken-over run must not keep writing over the run that replaced it.
	it("ignores a patch from a different pid", async () => {
		await publishRun(makeRun(), { path });
		await patchRun(
			"/repos/lullu",
			process.pid + 1,
			{ apps: [{ name: "api", status: "ready" }] },
			{ path },
		);
		const runs = await loadRuns(path);
		expect(runs[0]?.apps[0]?.status).toBe("starting");
	});

	it("drops an update for an app the run does not have", async () => {
		await publishRun(makeRun(), { path });
		await patchRun(
			"/repos/lullu",
			process.pid,
			{ apps: [{ name: "ghost", status: "ready" }] },
			{ path },
		);
		const runs = await loadRuns(path);
		expect(runs[0]?.apps).toHaveLength(1);
		expect(runs[0]?.apps[0]?.name).toBe("api");
	});
});

describe("withdrawRun", () => {
	it("removes only this process's entry", async () => {
		await publishRun(makeRun(), { path });
		await publishRun(makeRun({ root: "/repos/other" }), { path });
		await withdrawRun("/repos/lullu", process.pid, { path });
		const runs = await loadRuns(path);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.root).toBe("/repos/other");
	});

	it("leaves an entry owned by another pid alone", async () => {
		await publishRun(makeRun(), { path });
		await withdrawRun("/repos/lullu", process.pid + 1, { path });
		expect(await loadRuns(path)).toHaveLength(1);
	});
});

describe("groupRunsByProject", () => {
	it("groups by prefix with the main checkout first", () => {
		const groups = groupRunsByProject([
			makeRun({ root: "/w/b", worktree: "t3code-b", startedAt: "2026-01-02" }),
			makeRun({ root: "/main", worktree: null, startedAt: "2026-01-03" }),
			makeRun({ root: "/w/a", worktree: "t3code-a", startedAt: "2026-01-01" }),
		]);
		expect([...(groups.get("lullu") ?? [])].map((run) => run.worktree)).toEqual(
			[null, "t3code-a", "t3code-b"],
		);
	});
});

describe("loadRuns", () => {
	it("reads a missing file as no runs", async () => {
		expect(await loadRuns(join(dir, "absent.json"))).toEqual([]);
	});
});
