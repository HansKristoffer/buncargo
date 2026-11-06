import { describe, expect, it } from "bun:test";
import { RunInterrupted } from "../core/process/process-owner";
import {
	decideSignal,
	listenForInterrupts,
	SIGNAL_ECHO_MS,
} from "./dev-interrupts";

/** Interrupts on a clock the test moves; a forced exit is recorded, not taken. */
function listen() {
	let now = 1_000;
	const forced: number[] = [];
	const interrupts = listenForInterrupts({
		clock: () => now,
		forceExit: (code) => {
			forced.push(code);
			return undefined as never;
		},
	});
	return {
		interrupts,
		forced,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("decideSignal", () => {
	it("interrupts on the first signal and exits on a second one", () => {
		const first = decideSignal({ kind: "running" }, "SIGINT", 0);
		expect(first).toEqual({
			action: "interrupt",
			next: { kind: "interrupted", signal: "SIGINT", at: 0 },
		});
		if (first.action !== "interrupt") throw new Error("unreachable");
		expect(decideSignal(first.next, "SIGINT", 5_000)).toEqual({
			action: "force-exit",
			code: 130,
		});
		// A harness's SIGTERM after its SIGINT is a second signal too, and
		// exits with the first one's code.
		expect(decideSignal(first.next, "SIGTERM", 1)).toEqual({
			action: "force-exit",
			code: 130,
		});
	});

	it("reads the same signal at once as the first one again", () => {
		const state = {
			kind: "interrupted",
			signal: "SIGINT",
			at: 0,
		} as const;
		expect(decideSignal(state, "SIGINT", SIGNAL_ECHO_MS - 1)).toEqual({
			action: "ignore",
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

	it("exits on a second Ctrl-C instead of waiting for the teardown", () => {
		const { interrupts, forced, advance } = listen();
		try {
			process.emit("SIGINT");
			expect(forced).toEqual([]);
			advance(SIGNAL_ECHO_MS);
			process.emit("SIGINT");
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
