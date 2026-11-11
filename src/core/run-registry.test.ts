import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
	spyOn,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readProcessIdentity } from "./process-identity";
import {
	buildRunEntry,
	CHECKOUT_HOLD,
	clearRunStacks,
	describeRun,
	getRunsPath,
	groupRunsByProject,
	holdExpiry,
	LIVE,
	loadRuns,
	markOwnersLost,
	patchRun,
	publishRun,
	type RunEntry,
	type RunHold,
	readLiveRuns,
	releaseRun,
	retireProjectRuns,
	retireRuns,
	runLivenessAsync,
	runPhase,
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

function timed(ms: number, inherited = false): RunHold {
	return { kind: "timed", ms, inherited };
}

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
		lifecycle: LIVE,
		hold: CHECKOUT_HOLD,
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
			makeRun({ startedAt: "2026-01-01T00:00:00.000Z", hold: timed(60_000) }),
		);
		await describeRun(makeRun({ projectName: "renamed" }));
		const runs = await loadRuns();
		expect(runs).toHaveLength(1);
		expect(runs[0]).toMatchObject({
			projectName: "renamed",
			startedAt: "2026-01-01T00:00:00.000Z",
			hold: timed(60_000),
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
				hold: timed(1),
			}),
		);
		await patchRun("s1", {
			captures: { appUrl: "https://preview.example" },
			details: [{ label: "Preview", value: "https://preview.example" }],
			services: [{ name: "db", problem }],
		});
		await releaseRun("s1");
		const released = (await loadRuns())[0]?.lifecycle;

		const described = { port: 5432, url: "u", loopbackUrl: "u" };
		await describeRun(makeRun({ services: [{ ...DB, ...described }] }));
		const [entry] = await loadRuns();
		expect(released?.state).toBe("released");
		expect(entry?.lifecycle).toEqual(released);
		expect(entry?.hold).toEqual(timed(1));
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
		expect(entry?.lifecycle.state).toBe("released");
	});

	it("makes an entry the sweep stamped lost live again when its owner describes it", async () => {
		const claimed = makeRun({ services: [DB] });
		await publishRun(claimed);
		await markOwnersLost({
			lost: [claimed],
			back: [],
			at: "2026-01-01T00:00:00.000Z",
		});
		expect((await loadRuns())[0]?.lifecycle.state).toBe("lost");
		await describeRun(makeRun({ services: [DB] }));
		expect((await loadRuns())[0]?.lifecycle).toEqual(LIVE);
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
		await publishRun(makeRun({ services: [DB], hold: timed(5, true) }));
		await releaseRun("s1");
		await publishRun(makeRun({ services: [DB], hold: timed(60_000) }));
		const [entry] = await loadRuns();
		expect(entry?.hold).toEqual(timed(60_000));
		expect(entry?.lifecycle).toEqual(LIVE);
	});

	it("dates a reopened entry from the new claim and keeps the stacks it held", async () => {
		// `releaseRun()` then `start()` on one session. Keeping the first
		// claim's start ranked the reopened run below older ones, and made a
		// teardown keep the claims it had used since.
		const stack = { name: "supabase", down: ["supabase", "stop"] };
		await publishRun(
			makeRun({
				services: [DB],
				startedAt: "2026-01-01T00:00:00.000Z",
				stacks: [stack],
			}),
		);
		await releaseRun("s1");
		await publishRun(
			makeRun({ services: [DB], startedAt: "2026-01-02T00:00:00.000Z" }),
		);
		const [entry] = await loadRuns();
		expect(entry?.startedAt).toBe("2026-01-02T00:00:00.000Z");
		expect(entry?.stacks).toEqual([stack]);
	});

	it("keeps when a live entry started through another claim", async () => {
		await publishRun(
			makeRun({ services: [DB], startedAt: "2026-01-01T00:00:00.000Z" }),
		);
		await publishRun(
			makeRun({ services: [DB], startedAt: "2026-01-02T00:00:00.000Z" }),
		);
		expect((await loadRuns())[0]?.startedAt).toBe("2026-01-01T00:00:00.000Z");
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

	it("reads runs.json once per write through a four-app start", async () => {
		const names = ["web", "api", "admin", "docs"];
		const reads = spyOn(fsPromises, "readFile");
		try {
			const writes = [
				() => publishRun(makeRun({ services: [DB] })),
				() =>
					describeRun(
						makeRun({
							services: [DB],
							apps: names.map((name) => ({
								name,
								kind: "worker",
								status: "starting",
							})),
						}),
					),
				...names.flatMap((name, index) => [
					() => patchRun("s1", { apps: [{ name, pid: 1000 + index }] }),
					() => patchRun("s1", { apps: [{ name, status: "ready" }] }),
				]),
			];
			for (const write of writes) await write();
			const runsReads = reads.mock.calls.filter(([file]) => file === path);
			expect(runsReads).toHaveLength(writes.length);
		} finally {
			reads.mockRestore();
		}
		expect((await loadRuns())[0]?.apps.map((app) => app.status)).toEqual(
			names.map(() => "ready"),
		);
	});
});

describe("releaseRun", () => {
	it("keeps the first release, so repeated teardown cannot push the hold later", async () => {
		await publishRun(makeRun({ services: [DB] }));
		await releaseRun("s1");
		const first = (await loadRuns())[0]?.lifecycle;
		expect(first?.state).toBe("released");
		setSystemTime(new Date(Date.now() + 60_000));
		try {
			await releaseRun("s1");
		} finally {
			setSystemTime();
		}
		expect((await loadRuns())[0]?.lifecycle).toEqual(first);
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
	it("retireRuns drops exactly the entries it is given", async () => {
		for (const sessionId of ["a", "b", "c"])
			await publishRun(makeRun({ sessionId, services: [DB] }));
		const read = await loadRuns();
		await retireRuns(read.filter((run) => run.sessionId !== "b"));
		expect(await sessions()).toEqual(["b"]);
	});

	it("keeps a session that released and claimed again after it was read", async () => {
		// The sweep reads, spends minutes on `down`s, then retires: a library
		// session can have claimed again under the same id by then.
		await publishRun(makeRun({ services: [DB] }));
		await releaseRun("s1");
		const read = await loadRuns();
		await publishRun(makeRun({ services: [DB] }));
		await retireRuns(read);
		expect(await sessions()).toEqual(["s1"]);
	});

	it("keeps the stacks of a session that claimed again after it was read", async () => {
		const stacks = [{ name: "supabase", down: ["supabase", "stop"] }];
		await publishRun(makeRun({ services: [DB], stacks }));
		await releaseRun("s1");
		const read = await loadRuns();
		await clearRunStacks(read);
		expect((await loadRuns())[0]?.stacks).toBeUndefined();

		await publishRun(makeRun({ services: [DB], stacks }));
		await releaseRun("s1");
		const stale = await loadRuns();
		await publishRun(makeRun({ services: [DB], stacks }));
		await clearRunStacks(stale);
		expect((await loadRuns())[0]?.stacks).toEqual(stacks);
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
			downed: [{ runtime: "docker" }],
		});
		expect(await sessions()).toEqual(["neighbour", "other-project"]);
	});

	it("keeps a finished entry whose containers are on a runtime the teardown did not down", async () => {
		// A library `stop()` on Docker retired the entry of a stack held on
		// Apple's runtime, which `stop` keeps: one rule now decides both.
		const on = (runtime: "docker" | "apple") => ({
			...DB,
			container: { runtime, name: `lullu-lullu-db-${runtime}` },
		});
		await publishRun(makeRun({ sessionId: "mine", services: [on("docker")] }));
		await publishRun(
			makeRun({
				sessionId: "apple",
				pid: DEAD_PID,
				services: [on("apple")],
			}),
		);
		await publishRun(
			makeRun({
				sessionId: "docker",
				pid: DEAD_PID,
				services: [on("docker")],
			}),
		);
		await retireProjectRuns({
			projectName: "lullu-lullu",
			root: "/repos/lullu",
			sessionId: "mine",
			downed: [{ runtime: "docker" }],
		});
		expect(await sessions()).toEqual(["apple"]);

		// A teardown that downed nothing retires only its own session.
		await publishRun(makeRun({ sessionId: "mine", services: [on("docker")] }));
		await retireProjectRuns({
			projectName: "lullu-lullu",
			root: "/repos/lullu",
			sessionId: "mine",
			downed: [],
		});
		expect(await sessions()).toEqual(["apple"]);
	});
});

describe("markOwnersLost", () => {
	const FIRST = "2026-01-01T00:00:00.000Z";

	it("stamps a session once and never moves the stamp", async () => {
		await publishRun(makeRun({ services: [DB] }));
		const mark = (at: string) =>
			markOwnersLost({ lost: [makeRun()], back: [], at });
		await mark(FIRST);
		await mark("2026-06-01T00:00:00.000Z");
		expect((await loadRuns())[0]?.lifecycle).toEqual({
			state: "lost",
			at: FIRST,
		});
	});

	it("makes an owner found running again live, and never stamps a released run", async () => {
		await publishRun(makeRun({ services: [DB] }));
		await markOwnersLost({ lost: [makeRun()], back: [], at: FIRST });
		const back = makeRun({ lifecycle: { state: "lost", at: FIRST } });
		await markOwnersLost({ lost: [], back: [back], at: FIRST });
		expect((await loadRuns())[0]?.lifecycle).toEqual(LIVE);
		// The entry the sweep holds reads as on disk for the rest of its pass.
		expect(back.lifecycle).toEqual(LIVE);

		await releaseRun("s1");
		const released = (await loadRuns())[0]?.lifecycle;
		await markOwnersLost({ lost: [makeRun()], back: [], at: FIRST });
		expect((await loadRuns())[0]?.lifecycle).toEqual(released);
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

		await retireRuns(await loadRuns());
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
			await retireRuns(await loadRuns());
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

	it("lets a service come back after it was stopped, through starting", async () => {
		// A run that starts it again marks it `starting` and then `ready`; it
		// used to stay `stopped`.
		await publishRun(makeRun({ services: [DB] }));
		await patchRun("s1", { services: [{ name: "db", status: "stopped" }] });
		await patchRun("s1", { services: [{ name: "db", status: "starting" }] });
		await patchRun("s1", { services: [{ name: "db", status: "ready" }] });
		expect((await loadRuns())[0]?.services[0]?.status).toBe("ready");
	});

	it("never lets a late readiness report or a describe undo a stop", async () => {
		// Both say `ready` without having started anything since the stop.
		await publishRun(makeRun({ services: [DB] }));
		await patchRun("s1", { services: [{ name: "db", status: "stopped" }] });
		await patchRun("s1", { services: [{ name: "db", status: "ready" }] });
		await describeRun(makeRun({ services: [DB] }));
		expect((await loadRuns())[0]?.services[0]?.status).toBe("stopped");
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
			lifecycle: { state: "released", at: new Date().toISOString() },
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

describe("runPhase", () => {
	const at = "2026-01-01T00:00:00.000Z";

	it("is live only while the owner is alive and has not released", () => {
		expect(runPhase({ lifecycle: LIVE }, true)).toBe("live");
		expect(runPhase({ lifecycle: LIVE }, false)).toBe("lost");
		// Its owner reads as itself again: the sweep's stamp was wrong.
		expect(runPhase({ lifecycle: { state: "lost", at } }, true)).toBe("live");
		expect(runPhase({ lifecycle: { state: "lost", at } }, false)).toBe("lost");
		// A released run's pid may belong to anything by now.
		expect(runPhase({ lifecycle: { state: "released", at } }, true)).toBe(
			"released",
		);
	});
});

describe("holdExpiry", () => {
	const GRACE = 15_000;
	const at = "2026-01-01T00:00:00.000Z";
	const endedAt = Date.parse(at);
	const expiry = (lifecycle: RunEntry["lifecycle"], hold: RunHold) =>
		holdExpiry({ lifecycle, hold }, GRACE);

	it("dates a released run's own hold from its release", () => {
		expect(expiry({ state: "released", at }, timed(180_000))).toEqual({
			ended: "released",
			endedAt,
			holdMs: 180_000,
			inherited: false,
		});
	});

	it("gives a crashed run's own hold the grace, and keeps a reused hold", () => {
		expect(expiry({ state: "lost", at }, timed(180_000))?.holdMs).toBe(GRACE);
		expect(expiry({ state: "lost", at }, timed(180_000, true))?.holdMs).toBe(
			180_000,
		);
	});

	it("dates nothing for a live run, a hold of the checkout or an unreadable end", () => {
		expect(expiry(LIVE, timed(1))).toBeUndefined();
		expect(expiry({ state: "released", at }, CHECKOUT_HOLD)).toBeUndefined();
		expect(
			expiry({ state: "released", at: "not a date" }, timed(1)),
		).toBeUndefined();
	});
});

describe("runs.json schema", () => {
	function writeRuns(version: number, runs: unknown[]): void {
		writeFileSync(path, JSON.stringify({ version, runs }));
	}

	it("drops an entry whose worktree, branch, primary app or hosts do not read", async () => {
		const valid = makeRun({ sessionId: "valid" });
		writeRuns(2, [
			valid,
			{ ...valid, sessionId: "worktree", worktree: 7 },
			{ ...valid, sessionId: "branch", branch: ["main"] },
			{ ...valid, sessionId: "primary", primaryApp: 1 },
			{ ...valid, sessionId: "hosts", hosts: { active: "yes" } },
			{ ...valid, sessionId: "no-hosts", hosts: undefined },
			{ ...valid, sessionId: "hold", hold: { kind: "timed", ms: 1 } },
		]);
		expect(await sessions()).toEqual(["valid"]);
	});

	it("reads a v1 registry as empty, strictly too, and replaces it on the next write", async () => {
		writeRuns(1, [{ sessionId: "old", releasedAt: "2026-01-01T00:00:00Z" }]);
		expect(await loadRuns({ strict: true })).toEqual([]);
		expect(await readLiveRuns()).toEqual([]);

		await publishRun(makeRun({ sessionId: "new" }));
		expect(await sessions()).toEqual(["new"]);
		const backups = readdirSync(dirname(path)).filter((name) =>
			name.startsWith("runs.json.recovery-"),
		);
		expect(backups).toHaveLength(1);
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
				version: 2,
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
			JSON.stringify({ version: 2, runs: [unnamed, makeRun()] }),
		);
		expect(await sessions()).toEqual(["s1"]);
	});
});
