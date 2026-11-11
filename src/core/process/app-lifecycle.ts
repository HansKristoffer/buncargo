import { typedSwitch } from "hanzio";
import type { AppStateDetail } from "./run-output";

/**
 * One app's life in a run: a value, and a pure step from one value to the
 * next. The supervisor holds one per app and reports every step; the TUI and
 * stream rows, the log files and the run registry all read the same value, so
 * one exit has one verdict everywhere.
 */

type AppPhase = "starting" | "ready" | "restarting" | "reused" | "down";

/**
 * How the run treats the app going down.
 *
 * - `essential`: it ends the run.
 * - `optional`: `essential: false`; it never does.
 * - `probation`: an essential app not up yet, in a wave that spares the
 *   others. The wave decides once its waits settle.
 * - `parked`: an essential app that never came up, spared until a restart
 *   brings it up.
 */
type AppStanding = "essential" | "optional" | "probation" | "parked";

interface AppExit {
	/** `null` when it was signalled. */
	code: number | null;
	signal: NodeJS.Signals | null;
}

interface AppEnd {
	verdict: "stopped" | "failed";
	/** "exit 1", "signal SIGTERM", or why it never came up. */
	detail: string;
	/** How its last process exited, once that was seen. */
	exit?: AppExit;
	/** Why it is down, when it did not come up or could not be restarted. */
	failure?: AppFailure;
}

export interface AppLife {
	readonly phase: AppPhase;
	readonly standing: AppStanding;
	readonly worker: boolean;
	/** Has a readiness check (a health endpoint or `readyWhen`) to pass before it is up. */
	readonly checked: boolean;
	/** Owns the terminal: quitting it ends the run. */
	readonly attached: boolean;
	/** Bumped by every spawn and restart: what is said about one process never lands on the next. */
	readonly generation: number;
	/** The current or last process. A reused app has none of this run's. */
	readonly pid?: number;
	readonly end?: AppEnd;
}

export type AppEvent =
	| { type: "spawned"; pid: number; probation: boolean }
	/** A launcher exited 0 and left its server running: that server is the app now. */
	| { type: "adopted"; pid: number }
	/** Another process already serves its port. */
	| { type: "reused"; probation: boolean }
	| { type: "ready" }
	| { type: "restarting"; reason: string }
	/** `runEnding`: the run was already stopping, so the exit was asked for. */
	| { type: "exited"; exit: AppExit; runEnding: boolean }
	/** It never came up, or a restart could not replace it. `park` spares it. */
	| { type: "failed"; failure: AppFailure; park: boolean };

export type AppFailureKind =
	/** Its process exited while the run needed it. */
	| "exited"
	/** It did not pass its readiness check. */
	| "not-ready"
	/** A restart retired its process and could not start another. */
	| "restart"
	/** It could not be spawned, or its port could not be freed for it. */
	| "start";

/** An error about one app: what ends a run, or parks the app, names it here. */
export class AppFailure extends Error {
	constructor(
		readonly app: string,
		readonly kind: AppFailureKind,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export class RunInterrupted extends Error {}

export function initialLife(app: {
	optional: boolean;
	worker: boolean;
	checked: boolean;
	attached: boolean;
}): AppLife {
	return {
		phase: "starting",
		standing: app.optional ? "optional" : "essential",
		worker: app.worker,
		checked: app.checked,
		attached: app.attached,
		generation: 0,
	};
}

/**
 * Did this app stop because something asked it to?
 *
 * `null` is a process killed by a signal outright. The two codes are
 * `128 + SIGINT` and `128 + SIGTERM`, which is what a shell wrapper reports
 * when the signal reached it rather than the server it spawned — `bun run dev`
 * does exactly that. Without them a Ctrl-C, or a `buncargo stop`, ends a clean
 * shutdown with "App exited with code 143" and a failed run.
 */
function isDeliberateExit(
	code: number | null,
	signal?: NodeJS.Signals | null,
): boolean {
	return (
		(code === null &&
			(signal === undefined || signal === "SIGINT" || signal === "SIGTERM")) ||
		code === 0 ||
		code === 130 ||
		code === 143
	);
}

/**
 * How an exit of an app that was up reads: `stopped` when something asked it
 * to stop, else `failed`. A worker is meant to run until it is stopped, so an
 * essential one exiting 0 failed; a spared one only stopped.
 */
export function appExitState(
	code: number | null,
	signal: NodeJS.Signals | null | undefined,
	app: { worker: boolean; optional: boolean },
): "stopped" | "failed" {
	if (code === 0 && app.worker && !app.optional) return "failed";
	return isDeliberateExit(code, signal) ? "stopped" : "failed";
}

/** Spared: going down leaves the run going. */
function spared(standing: AppStanding): boolean {
	return standing === "optional" || standing === "parked";
}

function exitVerdict(
	life: AppLife,
	exit: AppExit,
	runEnding: boolean,
): "stopped" | "failed" {
	// Gone before it passed its check: it never came up, whatever its code.
	// Not when the run is ending, or `failed` would outlive a deliberate stop.
	// An app with no check is read by its code (a one-shot exits 0).
	const neverCameUp =
		!runEnding &&
		life.checked &&
		life.phase !== "ready" &&
		life.standing !== "optional";
	if (neverCameUp) return "failed";
	return appExitState(exit.code, exit.signal, {
		worker: life.worker,
		optional: spared(life.standing),
	});
}

function describeExit(exit: AppExit): string {
	return exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`;
}

export function transition(life: AppLife, event: AppEvent): AppLife {
	return typedSwitch(event, "type", {
		spawned: ({ pid, probation }) =>
			comingUp(life, { phase: "starting", pid, probation }),
		reused: ({ probation }) =>
			comingUp(life, { phase: "reused", pid: undefined, probation }),
		adopted: ({ pid }) => ({ ...life, pid }),
		ready: () => {
			// Only an app coming up becomes ready; an exited one stays as it ended.
			if (life.phase !== "starting" && life.phase !== "reused") return life;
			const standing = life.standing === "optional" ? "optional" : "essential";
			return { ...life, phase: "ready", standing, end: undefined };
		},
		restarting: () => ({
			...life,
			phase: "restarting",
			generation: life.generation + 1,
			end: undefined,
		}),
		exited: ({ exit, runEnding }) => {
			// Already down (stopped for never coming up): the reason stays.
			if (life.phase === "down" && life.end)
				return { ...life, end: { ...life.end, exit } };
			const verdict = exitVerdict(life, exit, runEnding);
			const end = { verdict, detail: describeExit(exit), exit };
			return { ...life, phase: "down", end };
		},
		failed: ({ failure, park }) => {
			const parked = park && life.standing !== "optional";
			// Neither stopped nor restartable from here: it keeps running.
			const detail =
				life.phase === "reused"
					? `${failure.message}; served by a process this run did not start, which is left running`
					: failure.message;
			return {
				...life,
				phase: "down",
				standing: parked ? "parked" : life.standing,
				end: { verdict: "failed", detail, exit: life.end?.exit, failure },
			};
		},
	});
}

function comingUp(
	life: AppLife,
	next: { phase: "starting" | "reused"; pid?: number; probation: boolean },
): AppLife {
	const standing =
		next.probation && life.standing === "essential"
			? "probation"
			: life.standing;
	return {
		...life,
		phase: next.phase,
		standing,
		generation: life.generation + 1,
		pid: next.pid,
		end: undefined,
	};
}

/** What the run does once an app's process exited. */
export function afterExit(
	before: AppLife,
	after: AppLife,
): "continues" | "fails" | "interrupts" {
	// Spared, or on probation, where its wave decides.
	if (spared(before.standing) || before.standing === "probation")
		return "continues";
	if (after.end?.verdict === "failed") return "fails";
	// Quitting the app that owns the terminal ends the run.
	if (before.attached) return "interrupts";
	return "continues";
}

/**
 * Whether going on without the essential apps that are down and failed ends
 * the run, and over which one: one that another app `startAfter`s (that app
 * cannot run without it), or the first when nothing is left running. Asked
 * before they are parked, so a run about to fail never says the rest keeps
 * going.
 */
export function runVerdict(
	lives: ReadonlyMap<string, AppLife>,
	startAfter: (name: string) => readonly string[] | undefined,
):
	{ ends: false } | { ends: true; app: string; dependents: readonly string[] } {
	const names = [...lives.keys()];
	const failed = names.filter((name) => {
		const life = lives.get(name);
		return (
			life?.phase === "down" &&
			life.end?.verdict === "failed" &&
			life.standing !== "optional"
		);
	});
	for (const app of failed) {
		const dependents = names.filter((name) => startAfter(name)?.includes(app));
		if (dependents.length > 0) return { ends: true, app, dependents };
	}
	const [first] = failed;
	// Nothing left running is a failed run, not one quietly waiting on
	// restarts nobody will ask for.
	const nothingLeft = names.every((name) => lives.get(name)?.phase === "down");
	if (first !== undefined && nothingLeft)
		return { ends: true, app: first, dependents: [] };
	return { ends: false };
}

/** Whether `r` / `buncargo restart` brings it back while the run goes on. */
function isRestartable(life: AppLife): boolean {
	// A reused app has no process of this run's to restart.
	return spared(life.standing) && life.pid !== undefined;
}

/** What the rows show: the TUI's sidebar, stream mode, the log files. */
export function appState(life: AppLife): AppStateDetail {
	return typedSwitch(life.phase, {
		starting: (): AppStateDetail => ({ state: "starting" }),
		restarting: (): AppStateDetail => ({ state: "starting" }),
		reused: (): AppStateDetail => ({ state: "starting" }),
		ready: (): AppStateDetail => ({ state: "ready" }),
		down: (): AppStateDetail => ({
			state: life.end?.verdict ?? "stopped",
			detail: life.end?.detail,
			restartable: isRestartable(life),
		}),
	});
}
