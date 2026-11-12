import { describe, expect, it } from "bun:test";
import {
	type AppEvent,
	AppFailure,
	type AppLife,
	afterExit,
	appExitState,
	appState,
	initialLife,
	runVerdict,
	transition,
} from "./app-lifecycle";

describe("appExitState", () => {
	const server = { worker: false, optional: false };
	const worker = { worker: true, optional: false };
	// Non-essential, or parked after it never came up.
	const optionalWorker = { worker: true, optional: true };

	it.each([
		[0, null, server, "stopped"],
		[1, null, server, "failed"],
		[130, null, server, "stopped"],
		[143, null, server, "stopped"],
		[null, "SIGTERM", server, "stopped"],
		[null, "SIGINT", server, "stopped"],
		[null, "SIGKILL", server, "failed"],
		[0, null, worker, "failed"],
		[null, "SIGTERM", worker, "stopped"],
		[0, null, optionalWorker, "stopped"],
		[1, null, optionalWorker, "failed"],
	] as const)("exit %p, signal %p, %o reads %s", (code, signal, app, state) => {
		expect(appExitState(code, signal, app)).toBe(state);
	});
});

const server = {
	optional: false,
	worker: false,
	checked: true,
	attached: false,
};
const failure = new AppFailure("web", "not-ready", "web did not respond");

function life(
	app: Partial<typeof server>,
	...events: Parameters<typeof transition>[1][]
): AppLife {
	return events.reduce(transition, initialLife({ ...server, ...app }));
}
const spawned = { type: "spawned", pid: 10, probation: false } as const;
const onProbation = { type: "spawned", pid: 10, probation: true } as const;
const ready = { type: "ready" } as const;
const exit0 = {
	type: "exited",
	exit: { code: 0, signal: null },
	runEnding: false,
} as const;
const sigterm = {
	type: "exited",
	exit: { code: null, signal: "SIGTERM" },
	runEnding: false,
} as const;
const sigtermAtEnd = { ...sigterm, runEnding: true } as const;

describe("transition: one verdict per exit", () => {
	it.each([
		["an app up that exits 0", life({}, spawned, ready, exit0), "stopped"],
		[
			"an essential worker up that exits 0",
			life({ worker: true, checked: false }, spawned, ready, exit0),
			"failed",
		],
		// The rows read `stopped (exit 0)` while the registry read `failed`.
		[
			"an app on probation that exits 0",
			life({}, onProbation, exit0),
			"failed",
		],
		["an app gone before its check passed", life({}, spawned, exit0), "failed"],
		[
			"a one-shot with no check that exits 0",
			life({ checked: false }, spawned, exit0),
			"stopped",
		],
		[
			"an app on probation stopped with the run",
			life({}, onProbation, sigtermAtEnd),
			"stopped",
		],
		[
			"a non-essential app gone before it came up",
			life({ optional: true }, spawned, exit0),
			"stopped",
		],
		[
			"an app stopped for never coming up",
			life({}, onProbation, { type: "failed", failure, park: true }, sigterm),
			"failed",
		],
	] as const)("%s reads %s", (_case, after, verdict) => {
		expect(after.phase).toBe("down");
		expect(after.end?.verdict).toBe(verdict);
		// The rows show what the registry records.
		expect(appState(after).state).toBe(verdict);
	});

	it("keeps why it never came up once its stop's exit arrives", () => {
		const parked = life({}, onProbation, {
			type: "failed",
			failure,
			park: true,
		});
		const stopped = transition(parked, sigterm);
		expect(stopped.end?.detail).toBe("web did not respond");
		expect(stopped.end?.failure).toBe(failure);
		expect(stopped.end?.exit).toEqual({ code: null, signal: "SIGTERM" });
	});
});

describe("transition: standing", () => {
	it("parks an essential app that failed, until a ready process makes it essential again", () => {
		const parked = life({}, onProbation, {
			type: "failed",
			failure,
			park: true,
		});
		expect(parked.standing).toBe("parked");
		expect(appState(parked)).toEqual({
			state: "failed",
			detail: "web did not respond",
			restartable: true,
		});

		const restarted = transition(parked, spawned);
		expect(restarted.standing).toBe("parked");
		expect(transition(restarted, ready).standing).toBe("essential");
	});

	it("leaves an app the run fails over essential, with no restart to offer", () => {
		const failed = life({}, spawned, { type: "failed", failure, park: false });
		expect(failed.standing).toBe("essential");
		expect(appState(failed).restartable).toBe(false);
	});

	it("says a reused app that failed is left running, and offers no restart", () => {
		const reused = life({}, { type: "reused", probation: true });
		const failed = transition(reused, { type: "failed", failure, park: true });
		expect(appState(failed)).toEqual({
			state: "failed",
			detail:
				"web did not respond; served by a process this run did not start, which is left running",
			restartable: false,
		});
	});

	it("never puts a non-essential app on probation or parks it", () => {
		const optional = life({ optional: true }, onProbation, {
			type: "failed",
			failure,
			park: true,
		});
		expect(optional.standing).toBe("optional");
		expect(appState(optional).restartable).toBe(true);
	});

	it("promotes only an app coming up, and starts a new generation per spawn and restart", () => {
		const down = life({}, spawned, ready, exit0);
		expect(transition(down, ready)).toBe(down);

		const first = life({}, spawned);
		const restarting = transition(first, {
			type: "restarting",
			reason: "requested",
		});
		expect(restarting.generation).toBeGreaterThan(first.generation);
		expect(transition(restarting, ready).phase).toBe("restarting");
		expect(transition(restarting, spawned).generation).toBeGreaterThan(
			restarting.generation,
		);
	});

	it("keeps the phase when a launcher's detached server is adopted", () => {
		const adopted = transition(life({}, spawned, ready), {
			type: "adopted",
			pid: 99,
		});
		expect(adopted).toMatchObject({ phase: "ready", pid: 99 });
	});
});

describe("afterExit", () => {
	const ends = (
		before: AppLife,
		event: Extract<AppEvent, { type: "exited" }>,
	) => afterExit(before, transition(before, event));

	it.each([
		[
			"an essential app up that fails",
			life({}, spawned, ready),
			sigkill(),
			"fails",
		],
		["an app gone before its check passed", life({}, spawned), exit0, "fails"],
		[
			"an essential app up, stopped on purpose",
			life({}, spawned, ready),
			sigterm,
			"continues",
		],
		[
			"the attached app quitting",
			life({ attached: true }, spawned, ready),
			exit0,
			"interrupts",
		],
		["an app on probation", life({}, onProbation), exit0, "continues"],
		[
			"a non-essential app crashing",
			life({ optional: true }, spawned, ready),
			sigkill(),
			"continues",
		],
	] as const)("%s %s", (_case, before, event, outcome) => {
		expect(ends(before, event)).toBe(outcome);
	});
});

function sigkill() {
	return {
		type: "exited",
		exit: { code: null, signal: "SIGKILL" },
		runEnding: false,
	} as const;
}

describe("runVerdict", () => {
	const failed = life({}, onProbation, { type: "failed", failure, park: true });
	const up = life({}, spawned, ready);
	const notSpawnedYet = initialLife(server);
	const optionalDown = life({ optional: true }, spawned, sigkill());
	const startAfter =
		(edges: Readonly<Record<string, readonly string[]>>) => (name: string) =>
			edges[name];

	it.each([
		[
			"goes on while another app runs",
			{ web: failed, api: up },
			{},
			{ ends: false },
		],
		[
			"ends over an app another starts after",
			{ web: failed, api: up, next: notSpawnedYet },
			{ next: ["web"] },
			{ ends: true, app: "web", dependents: ["next"] },
		],
		[
			"ends when nothing is left running",
			{ web: failed, side: optionalDown },
			{},
			{ ends: true, app: "web", dependents: [] },
		],
		[
			"counts an app of a later wave as still to come",
			{ web: failed, later: notSpawnedYet },
			{},
			{ ends: false },
		],
		[
			"never ends over a non-essential app, whatever starts after it",
			{ side: optionalDown, api: up },
			{ api: ["side"] },
			{ ends: false },
		],
	] as const)("%s", (_case, lives, edges, verdict) => {
		const map = new Map<string, AppLife>(Object.entries(lives));
		expect(runVerdict(map, startAfter(edges))).toEqual(verdict);
	});
});
