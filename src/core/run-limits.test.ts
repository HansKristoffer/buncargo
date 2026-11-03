import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckoutPresence } from "./checkout-presence";
import type { ProxyActivity } from "./hosts/proxy-activity";
import { readProcessIdentityAsync } from "./process-identity";
import { lastCheckoutCommandAt, noteCheckoutCommand } from "./run-activity";
import {
	createRunLimiter,
	decideRunLimit,
	idleState,
	type RunActivity,
	terminateRun,
} from "./run-limits";
import type { RunEntry } from "./run-registry";
import type { RunStopRecord } from "./run-stops";
import {
	DELETED_CHECKOUT_SETTLE_MS,
	DETACHED_IDLE_LIMIT_MS,
} from "./watchdog-constants";

const START = Date.parse("2026-11-03T08:00:00.000Z");
const HOUR = 60 * 60_000;

function entry(extra: Partial<RunEntry> = {}): RunEntry {
	return {
		sessionId: "s1",
		projectPrefix: "demo",
		projectName: "demo",
		root: "/repo",
		worktree: null,
		pid: 4242,
		processIdentity: "v2:4242",
		startedAt: new Date(START).toISOString(),
		updatedAt: new Date(START).toISOString(),
		detached: true,
		idleLimitMs: DETACHED_IDLE_LIMIT_MS,
		hosts: { active: true, tld: "localhost" },
		cli: { program: "bun" },
		apps: [],
		services: [],
		...extra,
	};
}

const counted = (proxy: Record<string, number> = {}): RunActivity => ({
	commandAt: undefined,
	proxy: new Map(Object.entries(proxy)),
});

/** The verdict for a live run whose checkout is there, at `now`. */
function verdictAt(run: RunEntry, activity: RunActivity, now: number) {
	return decideRunLimit({
		run,
		alive: true,
		checkout: "present",
		deletedSince: undefined,
		idle: idleState(run, activity),
		now,
	});
}

describe("the idle limit of a detached run", () => {
	it("stops a run nobody has used for two hours", () => {
		const run = entry();
		expect(verdictAt(run, counted(), START + 2 * HOUR - 1).kind).toBe("keep");
		expect(verdictAt(run, counted(), START + 2 * HOUR)).toMatchObject({
			kind: "stop",
			reason: "idle",
		});
	});

	it("never stops a run started with --keep", () => {
		const kept = entry({ idleLimitMs: undefined });
		expect(verdictAt(kept, counted(), START + 100 * HOUR)).toEqual({
			kind: "keep",
		});
	});

	it("counts from the last request through the proxy to its checkout", () => {
		const run = entry();
		const browsed = counted({ "/repo": START + 90 * 60_000 });
		expect(verdictAt(run, browsed, START + 2 * HOUR).kind).toBe("keep");
		// Another checkout's traffic is not this run's.
		expect(
			verdictAt(run, counted({ "/other": START + 2 * HOUR }), START + 2 * HOUR)
				.kind,
		).toBe("stop");
	});

	it("counts from the last buncargo command in its checkout", () => {
		const run = entry();
		const commanded = { commandAt: START + HOUR, proxy: new Map() };
		expect(verdictAt(run, commanded, START + 2 * HOUR).kind).toBe("keep");
		expect(verdictAt(run, commanded, START + 3 * HOUR).kind).toBe("stop");
	});

	it("never stops a run in a terminal", () => {
		const attached = entry({ detached: undefined });
		expect(idleState(attached, counted())).toEqual({ kind: "off" });
		expect(verdictAt(attached, counted(), START + 100 * HOUR).kind).toBe(
			"keep",
		);
	});

	it("does not judge a named-hosts run when no hosts daemon counts requests", () => {
		// An older daemon writes no activity file: no requests on record is
		// then no evidence, and stopping would cut off someone's open tab.
		const run = entry();
		const uncounted = { commandAt: undefined, proxy: undefined };
		expect(idleState(run, uncounted).kind).toBe("unknown");
		expect(verdictAt(run, uncounted, START + 100 * HOUR).kind).toBe("keep");
		// Without named hosts, there are no requests to miss.
		expect(
			verdictAt(entry({ hosts: null }), uncounted, START + 2 * HOUR).kind,
		).toBe("stop");
	});
});

describe("a detached run whose checkout was deleted", () => {
	const decide = (input: {
		alive?: boolean;
		run?: RunEntry;
		checkout?: CheckoutPresence;
		deletedSince: number | undefined;
		now: number;
	}) =>
		decideRunLimit({
			run: input.run ?? entry({ idleLimitMs: undefined }),
			alive: input.alive ?? true,
			checkout: input.checkout ?? "deleted",
			deletedSince: input.deletedSince,
			idle: { kind: "off" },
			now: input.now,
		});

	it("stops once the checkout has stayed deleted for the settle period, --keep or not", () => {
		const seen = START + HOUR;
		expect(decide({ deletedSince: seen, now: seen }).kind).toBe("keep");
		expect(
			decide({ deletedSince: seen, now: seen + DELETED_CHECKOUT_SETTLE_MS }),
		).toMatchObject({ kind: "stop", reason: "checkout deleted" });
	});

	it("never acts on a checkout it cannot read, or a run in a terminal", () => {
		const seen = START;
		const now = START + HOUR;
		expect(decide({ checkout: "unknown", deletedSince: seen, now }).kind).toBe(
			"keep",
		);
		expect(
			decide({
				run: entry({ detached: undefined }),
				deletedSince: seen,
				now,
			}).kind,
		).toBe("keep");
		expect(decide({ alive: false, deletedSince: seen, now }).kind).toBe("keep");
	});
});

describe("createRunLimiter", () => {
	function harness(runs: RunEntry[]) {
		const state = {
			clock: START,
			presence: "present" as CheckoutPresence,
			stopped: [] as string[],
			records: [] as RunStopRecord[],
		};
		const pass = createRunLimiter({
			readRuns: async () => runs,
			liveness: async () => (run) => run.releasedAt === undefined,
			checkoutPresence: () => state.presence,
			lastCommandAt: () => undefined,
			readProxyActivity: (): ProxyActivity => new Map(),
			stopRun: async (run) => {
				state.stopped.push(run.sessionId);
				return true;
			},
			recordStops: async (records) => {
				state.records.push(...records);
			},
			now: () => state.clock,
		});
		return { state, pass };
	}

	it("stops a deleted checkout's detached run only after it stayed deleted, and records why", async () => {
		// 13 detached runs 1 to 16 days old were found on one machine, several
		// serving worktrees that no longer existed.
		const { state, pass } = harness([entry({ idleLimitMs: undefined })]);
		state.presence = "deleted";
		expect((await pass()).stopped).toEqual([]);

		// Back in between: the clock starts over.
		state.clock += DELETED_CHECKOUT_SETTLE_MS / 2;
		state.presence = "present";
		await pass();
		state.presence = "deleted";
		state.clock += DELETED_CHECKOUT_SETTLE_MS / 2;
		await pass();
		expect(state.stopped).toEqual([]);

		state.clock += DELETED_CHECKOUT_SETTLE_MS;
		const result = await pass();
		expect(state.stopped).toEqual(["s1"]);
		expect(result.stopped).toEqual([
			"Stopped demo's detached run (/repo, pid 4242): its checkout /repo has been deleted for 10m",
		]);
		expect(state.records).toMatchObject([
			{ sessionId: "s1", root: "/repo", reason: "checkout deleted" },
		]);
	});

	it("stops an idle run at its limit, and leaves a --keep run and a terminal run alone", async () => {
		const { state, pass } = harness([
			entry({ sessionId: "idle" }),
			entry({ sessionId: "kept", idleLimitMs: undefined }),
			entry({ sessionId: "terminal", detached: undefined }),
		]);
		state.clock = START + DETACHED_IDLE_LIMIT_MS;
		await pass();
		expect(state.stopped).toEqual(["idle"]);
		expect(state.records[0]?.reason).toBe("idle");
	});
});

describe("terminateRun", () => {
	it("ends the run's process by its recorded pid and identity", async () => {
		const owner = Bun.spawn(
			[process.execPath, "--eval", "setInterval(() => {}, 1000)"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		try {
			const run = entry({
				pid: owner.pid,
				processIdentity: await readProcessIdentityAsync(owner.pid),
			});
			expect(await terminateRun(run)).toBe(true);
			expect(await owner.exited).not.toBeUndefined();
			// Gone now: nothing to signal, and nothing else is.
			expect(await terminateRun(run)).toBe(false);
		} finally {
			owner.kill("SIGKILL");
		}
	});
});

describe("noteCheckoutCommand", () => {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-run-activity-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it("marks a checkout that has buncargo state, and creates nothing elsewhere", () => {
		const fresh = join(dir, "fresh");
		mkdirSync(fresh);
		noteCheckoutCommand(fresh);
		expect(existsSync(join(fresh, ".buncargo"))).toBe(false);
		expect(lastCheckoutCommandAt(fresh)).toBeUndefined();

		const used = join(dir, "used");
		mkdirSync(join(used, ".buncargo"), { recursive: true });
		const before = Date.now();
		noteCheckoutCommand(used);
		expect(lastCheckoutCommandAt(used)).toBeGreaterThanOrEqual(before - 1_000);
	});
});
