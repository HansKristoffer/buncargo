import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentity } from "./process-identity";
import {
	buildRunEntry,
	groupRunsByProject,
	loadRuns,
	markOwnersLost,
	patchRun,
	publishRun,
	type RunEntry,
	readLiveRuns,
	releaseRun,
	retireProjectRuns,
	retireRuns,
	runLiveness,
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

const DB = { name: "db", status: "ready" as const };

function makeRun(overrides: Partial<RunEntry> = {}): RunEntry {
	const now = new Date().toISOString();
	return {
		sessionId: "s1",
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

async function sessions(): Promise<string[]> {
	return (await loadRuns(path)).map((run) => run.sessionId);
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

	it("updates a session in place, keeping when it started and the hold it claimed", async () => {
		// The claim, then the CLI's richer entry for the same session.
		await publishRun(
			makeRun({ startedAt: "2026-01-01T00:00:00.000Z", idleTimeoutMs: 60_000 }),
			{ path },
		);
		await publishRun(makeRun({ projectName: "renamed" }), { path });
		const runs = await loadRuns(path);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			projectName: "renamed",
			startedAt: "2026-01-01T00:00:00.000Z",
			idleTimeoutMs: 60_000,
		});
	});

	it("keeps separate sessions side by side, in one checkout or several", async () => {
		await publishRun(makeRun({ sessionId: "a" }), { path });
		await publishRun(makeRun({ sessionId: "b" }), { path });
		await publishRun(makeRun({ sessionId: "c", root: "/repos/other" }), {
			path,
		});
		expect(await sessions()).toEqual(["a", "b", "c"]);
	});

	it("prunes a dead run with nothing to hold, and keeps one that owns services", async () => {
		await publishRun(makeRun({ sessionId: "apps", pid: DEAD_PID }), { path });
		await publishRun(
			makeRun({ sessionId: "stack", pid: DEAD_PID, services: [DB] }),
			{ path },
		);
		await publishRun(makeRun({ sessionId: "live" }), { path });
		expect(await sessions()).toEqual(["stack", "live"]);
	});
});

describe("releaseRun", () => {
	it("keeps the first release, so repeated teardown cannot push the hold later", async () => {
		await publishRun(makeRun({ services: [DB] }), { path });
		await releaseRun("s1", { path });
		const first = (await loadRuns(path))[0]?.releasedAt;
		expect(first).toBeString();
		await Bun.sleep(5);
		await releaseRun("s1", { path });
		expect((await loadRuns(path))[0]?.releasedAt).toBe(first);
	});

	it("removes a session with no services outright", async () => {
		await publishRun(makeRun(), { path });
		await releaseRun("s1", { path });
		expect(await loadRuns(path)).toEqual([]);
	});

	it("leaves other sessions alone", async () => {
		await publishRun(makeRun({ sessionId: "a" }), { path });
		await releaseRun("b", { path });
		expect(await sessions()).toEqual(["a"]);
	});
});

describe("retiring entries", () => {
	it("retireRuns drops exactly the sessions it is given", async () => {
		for (const sessionId of ["a", "b", "c"])
			await publishRun(makeRun({ sessionId, services: [DB] }), { path });
		await retireRuns(["a", "c"], { path });
		expect(await sessions()).toEqual(["b"]);
	});

	it("an explicit teardown drops its own session and finished ones, not a live neighbour's", async () => {
		await publishRun(makeRun({ sessionId: "mine", services: [DB] }), { path });
		await publishRun(
			makeRun({ sessionId: "finished", pid: DEAD_PID, services: [DB] }),
			{ path },
		);
		// Another live session in the same checkout: still somebody's run.
		await publishRun(makeRun({ sessionId: "neighbour", services: [DB] }), {
			path,
		});
		await publishRun(
			makeRun({
				sessionId: "other-project",
				projectName: "other",
				pid: DEAD_PID,
				services: [DB],
			}),
			{ path },
		);
		await retireProjectRuns(
			{ projectName: "lullu-lullu", root: "/repos/lullu", sessionId: "mine" },
			{ path },
		);
		expect(await sessions()).toEqual(["neighbour", "other-project"]);
	});
});

describe("markOwnersLost", () => {
	it("stamps a session once and never moves the stamp", async () => {
		await publishRun(makeRun({ services: [DB] }), { path });
		await markOwnersLost(["s1"], "2026-01-01T00:00:00.000Z", { path });
		await markOwnersLost(["s1"], "2026-06-01T00:00:00.000Z", { path });
		expect((await loadRuns(path))[0]?.ownerLostAt).toBe(
			"2026-01-01T00:00:00.000Z",
		);
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
			"s1",
			{ apps: [{ name: "api", status: "ready", pid: 42 }] },
			{
				path,
			},
		);
		const runs = await loadRuns(path);
		expect(runs[0]?.apps[0]).toMatchObject({ status: "ready", pid: 42 });
		expect(runs[0]?.apps[1]?.status).toBe("starting");
	});

	// A taken-over run starts a new session, so it cannot write over its
	// replacement: its patches address only its own entry.
	it("writes only to the session it names", async () => {
		await publishRun(makeRun({ sessionId: "old" }), { path });
		await publishRun(makeRun({ sessionId: "new" }), { path });
		await patchRun(
			"new",
			{ apps: [{ name: "api", status: "ready" }] },
			{
				path,
			},
		);
		const runs = await loadRuns(path);
		expect(runs.map((run) => run.apps[0]?.status)).toEqual([
			"starting",
			"ready",
		]);
	});

	it("drops an update for an app the run does not have", async () => {
		await publishRun(makeRun(), { path });
		await patchRun(
			"s1",
			{ apps: [{ name: "ghost", status: "ready" }] },
			{
				path,
			},
		);
		const runs = await loadRuns(path);
		expect(runs[0]?.apps).toHaveLength(1);
		expect(runs[0]?.apps[0]?.name).toBe("api");
	});

	it("does not let late readiness resurrect a stopped app", async () => {
		await publishRun(makeRun(), { path });
		await patchRun(
			"s1",
			{ apps: [{ name: "api", status: "stopped" }] },
			{
				path,
			},
		);
		await patchRun(
			"s1",
			{ apps: [{ name: "api", status: "ready" }] },
			{
				path,
			},
		);
		expect((await loadRuns(path))[0]?.apps[0]?.status).toBe("stopped");
	});
});

describe("liveness", () => {
	it("counts a live owner and never a released one, from one reading", () => {
		const identity = readProcessIdentity(process.pid);
		const live = makeRun({ sessionId: "live", processIdentity: identity });
		const released = makeRun({
			sessionId: "released",
			processIdentity: identity,
			releasedAt: new Date().toISOString(),
		});
		const dead = makeRun({ sessionId: "dead", pid: DEAD_PID });
		const alive = runLiveness([live, released, dead]);
		expect([live, released, dead].map(alive)).toEqual([true, false, false]);
	});

	it("filters a reused pid without writing the registry during inspection", async () => {
		await publishRun(makeRun({ processIdentity: "v2:another-process" }), {
			path,
		});
		const before = readFileSync(path, "utf8");
		expect(await readLiveRuns(path)).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});

describe("identities written by older versions", () => {
	it("never condemns a live run for an identity it cannot compare", async () => {
		// Recorded in whatever locale and time zone that version ran in. Reading
		// it as a mismatch would let the sweep tear down a live 9.x run's stack.
		await publishRun(makeRun({ processIdentity: "legacy-unprefixed-hash" }), {
			path,
		});
		expect(await sessions()).toEqual(["s1"]);
		expect(await readLiveRuns(path)).toHaveLength(1);
	});
});

describe("buildRunEntry", () => {
	it("records this process and buncargo's own CLI, never the running script", () => {
		const entry = buildRunEntry({
			sessionId: "s1",
			projectPrefix: "lullu",
			projectName: "lullu-lullu",
			root: "/repos/lullu",
			isWorktree: false,
		});
		expect(entry.pid).toBe(process.pid);
		expect(entry.processIdentity).toBe(readProcessIdentity(process.pid));
		expect(entry.worktree).toBeNull();
		expect(entry.cli.script).toEndWith(join("cli", "bin.ts"));
		expect(entry.cli.script).not.toBe(process.argv[1]);
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

describe("the persisted boundary", () => {
	it("reads a missing file as no runs", async () => {
		expect(await loadRuns(join(dir, "absent.json"))).toEqual([]);
	});

	it("rejects invalid target pids and ports", async () => {
		const run = makeRun();
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				runs: [
					{ ...run, pid: -1 },
					{ ...run, apps: [{ ...run.apps[0], port: 70000 }] },
				],
			}),
		);
		expect(await loadRuns(path)).toEqual([]);
	});

	it("drops an entry with no session id, which only old versions wrote", async () => {
		const { sessionId: _dropped, ...legacy } = makeRun();
		writeFileSync(
			path,
			JSON.stringify({ version: 1, runs: [legacy, makeRun()] }),
		);
		expect(await sessions()).toEqual(["s1"]);
	});
});
