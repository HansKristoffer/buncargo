import { describe, expect, it } from "bun:test";
import { RunInterrupted } from "../core/process/app-lifecycle";
import {
	decideSignal,
	type InterruptState,
	listenForInterrupts,
	SIGNAL_ECHO_MS,
} from "./dev-interrupts";

/**
 * Interrupts on a clock the test moves, with the apps the test says are still
 * stopping; a warning or a forced exit is recorded, not taken.
 */
function listen() {
	let now = 1_000;
	let stopping: string[] = [];
	const forced: number[] = [];
	const warned: (readonly string[])[] = [];
	const interrupts = listenForInterrupts({
		clock: () => now,
		stopping: () => stopping,
		warn: (apps) => warned.push(apps),
		forceExit: (code) => {
			forced.push(code);
			return undefined as never;
		},
	});
	return {
		interrupts,
		forced,
		warned,
		advance: (ms: number) => {
			now += ms;
		},
		stillStopping: (apps: string[]) => {
			stopping = apps;
		},
	};
}

describe("decideSignal", () => {
	it("interrupts on the first signal and exits on a second one", () => {
		const first = decideSignal({ kind: "running" }, "SIGINT", 0, []);
		expect(first).toEqual({
			action: "interrupt",
			next: {
				kind: "interrupted",
				signal: "SIGINT",
				last: "SIGINT",
				at: 0,
				warned: false,
			},
		});
		if (first.action !== "interrupt") throw new Error("unreachable");
		expect(decideSignal(first.next, "SIGINT", 5_000, [])).toEqual({
			action: "force-exit",
			code: 130,
		});
		// A harness's SIGTERM after its SIGINT is a second signal too, and
		// exits with the first one's code.
		expect(decideSignal(first.next, "SIGTERM", 1, [])).toEqual({
			action: "force-exit",
			code: 130,
		});
	});

	it("reads the same signal at once as the one before again", () => {
		const state: InterruptState = {
			kind: "interrupted",
			signal: "SIGINT",
			last: "SIGINT",
			at: 0,
			warned: false,
		};
		expect(decideSignal(state, "SIGINT", SIGNAL_ECHO_MS - 1, [])).toEqual({
			action: "ignore",
		});
	});

	// A double-tap (150-300ms) passes the echo filter, and exiting closed the
	// pseudo-terminal of a Firebase emulator exporting its data on exit.
	it("only warns on a second signal while apps are still stopping, and exits on a third", () => {
		const first = decideSignal({ kind: "running" }, "SIGINT", 0, ["firebase"]);
		if (first.action !== "interrupt") throw new Error("unreachable");
		const second = decideSignal(first.next, "SIGINT", 200, ["firebase"]);
		expect(second).toEqual({
			action: "warn",
			apps: ["firebase"],
			next: {
				kind: "interrupted",
				signal: "SIGINT",
				last: "SIGINT",
				at: 200,
				warned: true,
			},
		});
		if (second.action !== "warn") throw new Error("unreachable");
		// The terminal's echo of the second one is the second one.
		expect(
			decideSignal(second.next, "SIGINT", 200 + SIGNAL_ECHO_MS - 1, [
				"firebase",
			]),
		).toEqual({ action: "ignore" });
		expect(decideSignal(second.next, "SIGINT", 2_000, ["firebase"])).toEqual({
			action: "force-exit",
			code: 130,
		});
	});
});

describe("listenForInterrupts", () => {
	it("aborts with RunInterrupted and reports 128 + the signal", () => {
		const { interrupts } = listen();
		try {
			expect(interrupts.exitCode()).toBeUndefined();
			process.emit("SIGTERM");
			expect(interrupts.signal.reason).toBeInstanceOf(RunInterrupted);
			expect(interrupts.exitCode()).toBe(143);
		} finally {
			interrupts.dispose();
		}
	});

	it("exits on a second Ctrl-C once the apps are down, instead of waiting for the teardown", () => {
		const { interrupts, forced, warned, advance } = listen();
		try {
			process.emit("SIGINT");
			expect(forced).toEqual([]);
			advance(SIGNAL_ECHO_MS);
			process.emit("SIGINT");
			expect(warned).toEqual([]);
			expect(forced).toEqual([130]);
		} finally {
			interrupts.dispose();
		}
	});

	it("names the apps still stopping on a second Ctrl-C, and exits on a third", () => {
		const { interrupts, forced, warned, advance, stillStopping } = listen();
		try {
			stillStopping(["firebase", "api"]);
			process.emit("SIGINT");
			advance(200);
			process.emit("SIGINT");
			expect(warned).toEqual([["firebase", "api"]]);
			expect(forced).toEqual([]);
			advance(200);
			process.emit("SIGINT");
			expect(forced).toEqual([130]);
		} finally {
			interrupts.dispose();
		}
	});

	it("exits on a second Ctrl-C once the apps it waited for are down", () => {
		const { interrupts, forced, warned, advance, stillStopping } = listen();
		try {
			stillStopping(["firebase"]);
			process.emit("SIGINT");
			stillStopping([]);
			advance(5_000);
			process.emit("SIGINT");
			expect(warned).toEqual([]);
			expect(forced).toEqual([130]);
		} finally {
			interrupts.dispose();
		}
	});

	it("takes the SIGINT a prompt raises as the interrupt it already reported", () => {
		const { interrupts, forced, advance } = listen();
		try {
			interrupts.promptInterrupted();
			expect(interrupts.exitCode()).toBe(130);
			advance(1);
			process.emit("SIGINT");
			expect(forced).toEqual([]);
		} finally {
			interrupts.dispose();
		}
	});

	it("stops listening once disposed", () => {
		const { interrupts } = listen();
		const before = process.listenerCount("SIGINT");
		interrupts.dispose();
		expect(process.listenerCount("SIGINT")).toBe(before - 1);
	});
});
