import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readProcessIdentity } from "./process-identity";
import {
	buildRunEntry,
	describeRun,
	getRunsPath,
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
	runLivenessAsync,
} from "./run-registry";

const realHome = process.env.HOME;
let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "buncargo-runs-"));
	process.env.HOME = dir;
	path = getRunsPath();
	mkdirSync(dirname(path), { recursive: true });
});

afterEach(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(dir, { recursive: true, force: true });
});

/** A pid that is certainly not running. */
const DEAD_PID = 2 ** 22;

const DB = { name: "db", status: "ready" as const };
const CONTAINER = {
	runtime: "docker" as const,
	name: "lullu-lullu-db",
	service: "db",
};

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
	return (await loadRuns()).map((run) => run.sessionId);
}

describe("publishRun", () => {
	it("round-trips an entry", async () => {
		await publishRun(makeRun());
		const runs = await loadRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]?.projectName).toBe("lullu-lullu");
		expect(runs[0]?.apps[0]?.name).toBe("api");
	});

	// The file carries the dev database password from the compose defaults.
	it("writes the registry unreadable by other users", async () => {
		await publishRun(makeRun());
		expect(statSync(path).mode & 0o077).toBe(0);
	});

	it("updates a session in place, keeping when it started and the hold it claimed", async () => {
		// The claim, then the CLI's richer entry for the same session.
		await publishRun(
			makeRun({ startedAt: "2026-01-01T00:00:00.000Z", idleTimeoutMs: 60_000 }),
		);
		await describeRun(makeRun({ projectName: "renamed" }));
		const runs = await loadRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			projectName: "renamed",
			startedAt: "2026-01-01T00:00:00.000Z",
			idleTimeoutMs: 60_000,
		});
	});

	it("never lets a describe undo a release or drop what other writers recorded", async () => {
		// `claimApps` describes the entry again; it used to replace it whole,
		// reopening a released run and dropping captures, details and problems.
		const problem = {
			state: "stopped" as const,
			detail: "db stopped (exit 0)",
			since: "2026-01-01T00:00:00.000Z",
		};
		await publishRun(
			makeRun({
				services: [{ ...DB, container: CONTAINER }],
				idleTimeoutMs: 1,
			}),
		);
		await patchRun("s1", {
			captures: { appUrl: "https://preview.example" },
			details: [{ label: "Preview", value: "https://preview.example" }],
			services: [{ name: "db", problem }],
		});
		await releaseRun("s1");
		await markOwnersLost(["s1"], "2026-01-01T00:00:00.000Z");
		const released = (await loadRuns())[0]?.releasedAt;

		const described = { port: 5432, url: "u", loopbackUrl: "u" };
		await describeRun(makeRun({ services: [{ ...DB, ...described }] }));
		const [entry] = await loadRuns();
		expect(entry?.releasedAt).toBe(released);
		// The owner wrote it, so it is not lost.
		expect(entry?.ownerLostAt).toBeUndefined();
		expect(entry?.idleTimeoutMs).toBe(1);
		expect(entry?.captures).toEqual({ appUrl: "https://preview.example" });
		expect(entry?.details).toHaveLength(1);
		expect(entry?.services[0]).toMatchObject({
			...described,
			container: CONTAINER,
			problem,
		});
	});

	it("keeps the claimed services when a describe lists none, so a release still holds them", async () => {
		// A library `claimApps` after `releaseRun()` describes no services. The
		// entry lost its services record, and the next release withdrew it.
		await publishRun(makeRun({ services: [DB] }));
		await describeRun(makeRun({ services: [] }));
		await releaseRun("s1");
		const [entry] = await loadRuns();
		expect(entry?.services.map((service) => service.name)).toEqual(["db"]);
		expect(entry?.releasedAt).toBeString();
	});

	it("keeps each app's process and state through a describe", async () => {
		await publishRun(makeRun());
		await patchRun("s1", {
			apps: [
				{ name: "api", pid: 42, processIdentity: "v2:x", status: "ready" },
			],
		});
		await describeRun(makeRun());
		expect((await loadRuns())[0]?.apps[0]).toMatchObject({
			pid: 42,
			processIdentity: "v2:x",
			status: "ready",
		});
	});

	it("gives a claim exactly the hold it names, and reopens a released entry", async () => {
		await publishRun(makeRun({ services: [DB], inheritedIdleTimeoutMs: 5 }));
		await releaseRun("s1");
		await publishRun(makeRun({ services: [DB], idleTimeoutMs: 60_000 }));
		const [entry] = await loadRuns();
		expect(entry?.idleTimeoutMs).toBe(60_000);
		expect(entry?.inheritedIdleTimeoutMs).toBeUndefined();
		expect(entry?.releasedAt).toBeUndefined();
	});

	it("keeps separate sessions side by side, in one checkout or several", async () => {
		await publishRun(makeRun({ sessionId: "a" }));
		await publishRun(makeRun({ sessionId: "b" }));
		await publishRun(makeRun({ sessionId: "c", root: "/repos/other" }));
		expect(await sessions()).toEqual(["a", "b", "c"]);
	});

	it("prunes a dead run with nothing to hold, and keeps one that owns services", async () => {
		await publishRun(makeRun({ sessionId: "apps", pid: DEAD_PID }));
		await publishRun(
			makeRun({ sessionId: "stack", pid: DEAD_PID, services: [DB] }),
		);
		await publishRun(makeRun({ sessionId: "live" }));
		expect(await sessions()).toEqual(["stack", "live"]);
	});
});

describe("releaseRun", () => {
	it("keeps the first release, so repeated teardown cannot push the hold later", async () => {
		await publishRun(makeRun({ services: [DB] }));
		await releaseRun("s1");
		const first = (await loadRuns())[0]?.releasedAt;
		expect(first).toBeString();
		setSystemTime(new Date(Date.now() + 60_000));
		try {
			await releaseRun("s1");
		} finally {
			setSystemTime();
		}
		expect((await loadRuns())[0]?.releasedAt).toBe(first);
	});

	it("removes a session with no services outright", async () => {
		await publishRun(makeRun());
		await releaseRun("s1");
		expect(await loadRuns()).toEqual([]);
	});

	it("leaves other sessions alone", async () => {
		await publishRun(makeRun({ sessionId: "a" }));
		await releaseRun("b");
		expect(await sessions()).toEqual(["a"]);
	});
});

describe("retiring entries", () => {
	it("retireRuns drops exactly the sessions it is given", async () => {
		for (const sessionId of ["a", "b", "c"])
			await publishRun(makeRun({ sessionId, services: [DB] }));
		await retireRuns(["a", "c"]);
		expect(await sessions()).toEqual(["b"]);
	});

	it("an explicit teardown drops its own session and finished ones, not a live neighbour's", async () => {
		await publishRun(makeRun({ sessionId: "mine", services: [DB] }));
		await publishRun(
			makeRun({ sessionId: "finished", pid: DEAD_PID, services: [DB] }),
		);
		// Another live session in the same checkout: still somebody's run.
		await publishRun(makeRun({ sessionId: "neighbour", services: [DB] }));
		await publishRun(
			makeRun({
				sessionId: "other-project",
				projectName: "other",
				pid: DEAD_PID,
				services: [DB],
			}),
		);
		await retireProjectRuns({
			projectName: "lullu-lullu",
			root: "/repos/lullu",
			sessionId: "mine",
		});
		expect(await sessions()).toEqual(["neighbour", "other-project"]);
	});
});

describe("markOwnersLost", () => {
	it("stamps a session once and never moves the stamp", async () => {
		await publishRun(makeRun({ services: [DB] }));
		await markOwnersLost(["s1"], "2026-01-01T00:00:00.000Z");
		await markOwnersLost(["s1"], "2026-06-01T00:00:00.000Z");
		expect((await loadRuns())[0]?.ownerLostAt).toBe("2026-01-01T00:00:00.000Z");
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
		);
		await patchRun("s1", { apps: [{ name: "api", status: "ready", pid: 42 }] });
		const runs = await loadRuns();
		expect(runs[0]?.apps[0]).toMatchObject({ status: "ready", pid: 42 });
		expect(runs[0]?.apps[1]?.status).toBe("starting");
	});

	// A taken-over run starts a new session, so it cannot write over its
	// replacement: its patches address only its own entry.
	it("writes only to the session it names", async () => {
		await publishRun(makeRun({ sessionId: "old" }));
		await publishRun(makeRun({ sessionId: "new" }));
		await patchRun("new", { apps: [{ name: "api", status: "ready" }] });
		const runs = await loadRuns();
		expect(runs.map((run) => run.apps[0]?.status)).toEqual([
			"starting",
			"ready",
		]);
	});

	it("drops an update for an app the run does not have", async () => {
		await publishRun(makeRun());
		await patchRun("s1", { apps: [{ name: "ghost", status: "ready" }] });
		const runs = await loadRuns();
		expect(runs[0]?.apps).toHaveLength(1);
		expect(runs[0]?.apps[0]?.name).toBe("api");
	});

	it("does not let late readiness resurrect a stopped app", async () => {
		await publishRun(makeRun());
		await patchRun("s1", { apps: [{ name: "api", status: "stopped" }] });
		await patchRun("s1", { apps: [{ name: "api", status: "ready" }] });
		expect((await loadRuns())[0]?.apps[0]?.status).toBe("stopped");
	});

	it("lets a restarted app (a new pid) start over after it stopped", async () => {
		await publishRun(makeRun());
		const read = async () => (await loadRuns())[0]?.apps[0];
		await patchRun("s1", { apps: [{ name: "api", status: "failed" }] });
		// What `recordAppSpawn` sends for the replacement: a pid, no status.
		await patchRun("s1", { apps: [{ name: "api", pid: process.ppid }] });
		expect(await read()).toMatchObject({
			pid: process.ppid,
			status: "starting",
		});
		await patchRun("s1", { apps: [{ name: "api", status: "ready" }] });
		expect((await read())?.status).toBe("ready");
		// The same pid again is not a restart: a stopped app stays stopped.
		await patchRun("s1", { apps: [{ name: "api", status: "stopped" }] });
		await patchRun("s1", {
			apps: [{ name: "api", pid: process.ppid, status: "starting" }],
		});
		expect((await read())?.status).toBe("stopped");
	});

	it("keeps an app stopped when its run reports the exit as a failure, in either order", async () => {
		// `stop` and the owning run both record the end after SIGTERM; an app
		// that exits non-zero on it was still stopped on purpose.
		const read = async () => (await loadRuns())[0]?.apps[0]?.status;
		await publishRun(makeRun());
		await patchRun("s1", { apps: [{ name: "api", status: "stopped" }] });
		await patchRun("s1", { apps: [{ name: "api", status: "failed" }] });
		expect(await read()).toBe("stopped");

		await retireRuns(["s1"]);
		await publishRun(makeRun());
		await patchRun("s1", { apps: [{ name: "api", status: "failed" }] });
		await patchRun("s1", { apps: [{ name: "api", status: "stopped" }] });
		expect(await read()).toBe("stopped");
	});

	it("puts a restarting app back to starting until its new process is ready", async () => {
		// A new pid on a running app reads as adoption, so a restarted app kept
		// `ready` and `restart && wait` returned on the replaced process.
		const read = async () => (await loadRuns())[0]?.apps[0];
		for (const before of ["ready", "failed", "stopped"] as const) {
			await retireRuns(["s1"]);
			await publishRun(makeRun());
			await patchRun("s1", {
				apps: [{ name: "api", pid: 41, status: before }],
			});
			await patchRun("s1", { restarting: ["api"] });
			expect((await read())?.status).toBe("starting");
			await patchRun("s1", { apps: [{ name: "api", pid: 42 }] });
			expect(await read()).toMatchObject({ pid: 42, status: "starting" });
			await patchRun("s1", { apps: [{ name: "api", status: "ready" }] });
			expect((await read())?.status).toBe("ready");
		}
	});

	it("lets a service come back after it was stopped", async () => {
		// Its states are written after the fact, never reported late: a run
		// that starts it again marks it ready, and it used to stay `stopped`.
		await publishRun(makeRun({ services: [DB] }));
		await patchRun("s1", { services: [{ name: "db", status: "stopped" }] });
		await patchRun("s1", { services: [{ name: "db", status: "ready" }] });
		expect((await loadRuns())[0]?.services[0]?.status).toBe("ready");
	});

	it("keeps a running app's status when it adopts a detached pid", async () => {
		await publishRun(makeRun());
		await patchRun("s1", { apps: [{ name: "api", status: "ready" }] });
		await patchRun("s1", { apps: [{ name: "api", pid: process.ppid + 1 }] });
		expect((await loadRuns())[0]?.apps[0]).toMatchObject({
			pid: process.ppid + 1,
			status: "ready",
		});
	});
});

describe("liveness", () => {
	it("counts a live owner and never a released one, from one reading", async () => {
		const identity = readProcessIdentity(process.pid);
		const live = makeRun({ sessionId: "live", processIdentity: identity });
		const released = makeRun({
			sessionId: "released",
			processIdentity: identity,
			releasedAt: new Date().toISOString(),
		});
		const dead = makeRun({ sessionId: "dead", pid: DEAD_PID });
		const alive = await runLivenessAsync([live, released, dead]);
		expect([live, released, dead].map(alive)).toEqual([true, false, false]);
	});

	it("filters a reused pid without writing the registry during inspection", async () => {
		await publishRun(makeRun({ processIdentity: "v2:another-process" }));
		const before = readFileSync(path, "utf8");
		expect(await readLiveRuns()).toEqual([]);
		expect(readFileSync(path, "utf8")).toBe(before);
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
		expect(await loadRuns()).toEqual([]);
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
		expect(await loadRuns()).toEqual([]);
	});

	it("drops an entry with no session id", async () => {
		const { sessionId: _dropped, ...unnamed } = makeRun();
		writeFileSync(
			path,
			JSON.stringify({ version: 1, runs: [unnamed, makeRun()] }),
		);
		expect(await sessions()).toEqual(["s1"]);
	});
});
