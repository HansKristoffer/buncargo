import { describe, expect, it } from "bun:test";
import {
	evaluateWatchdogTick,
	type WatchdogLimits,
	type WatchdogMemory,
} from "./watchdog-decision";

const LIMITS: WatchdogLimits = {
	idleTimeoutMs: 180_000,
	ownerDeadGraceMs: 15_000,
};

const FRESH: WatchdogMemory = { ownerDeadSince: null };
const NOW = 1_000_000;

describe("evaluateWatchdogTick", () => {
	it("stays healthy while the owner is alive", () => {
		const { verdict, memory } = evaluateWatchdogTick(
			{
				now: NOW,
				reading: { status: "ok", payload: { ts: NOW - 1_000, pid: 42 } },
				ownerAlive: true,
			},
			{ ownerDeadSince: NOW - 60_000 },
			LIMITS,
		);
		expect(verdict).toEqual({ kind: "healthy" });
		expect(memory.ownerDeadSince).toBeNull();
	});

	// The regression: a deliberate Ctrl-C used to hit the 15s crash grace, so
	// restarting cost a full container recreate.
	it("holds a released stack through the crash grace", () => {
		const { verdict } = evaluateWatchdogTick(
			{
				now: NOW,
				reading: {
					status: "ok",
					payload: { ts: NOW - 30_000, pid: 0, released: true },
				},
				ownerAlive: false,
			},
			FRESH,
			LIMITS,
		);
		expect(verdict).toEqual({ kind: "waiting" });
	});

	it("shuts down a released stack once the idle backstop elapses", () => {
		const { verdict } = evaluateWatchdogTick(
			{
				now: NOW,
				reading: {
					status: "ok",
					payload: { ts: NOW - 180_000, pid: 0, released: true },
				},
				ownerAlive: false,
			},
			FRESH,
			LIMITS,
		);
		expect(verdict.kind).toBe("shutdown");
		expect(verdict.kind === "shutdown" && verdict.reason).toContain("released");
	});

	it("keeps the short grace for an owner that crashed without releasing", () => {
		const crashed = {
			now: NOW,
			reading: {
				status: "ok" as const,
				payload: { ts: NOW - 20_000, pid: 42 },
			},
			ownerAlive: false,
		};

		expect(
			evaluateWatchdogTick(crashed, { ownerDeadSince: NOW - 5_000 }, LIMITS)
				.verdict.kind,
		).toBe("waiting");

		expect(
			evaluateWatchdogTick(crashed, { ownerDeadSince: NOW - 15_000 }, LIMITS)
				.verdict.kind,
		).toBe("shutdown");
	});

	it("records when the owner first looked gone", () => {
		const { memory } = evaluateWatchdogTick(
			{
				now: NOW,
				reading: { status: "ok", payload: { ts: NOW - 1_000, pid: 42 } },
				ownerAlive: false,
			},
			FRESH,
			LIMITS,
		);
		expect(memory.ownerDeadSince).toBe(NOW);
	});

	it("shuts down when the heartbeat file was removed outright", () => {
		expect(
			evaluateWatchdogTick(
				{ now: NOW, reading: { status: "missing" }, ownerAlive: false },
				{ ownerDeadSince: NOW - 15_000 },
				LIMITS,
			).verdict.kind,
		).toBe("shutdown");
	});

	it("waits out the grace before acting on a missing file", () => {
		expect(
			evaluateWatchdogTick(
				{ now: NOW, reading: { status: "missing" }, ownerAlive: false },
				{ ownerDeadSince: NOW - 5_000 },
				LIMITS,
			).verdict.kind,
		).toBe("waiting");
	});

	// A torn write must not condemn the stack, but the old loop `continue`d
	// forever on an unreadable file and could never shut down.
	it("tolerates a torn read but does not wait forever", () => {
		expect(
			evaluateWatchdogTick(
				{ now: NOW, reading: { status: "unreadable" }, ownerAlive: false },
				{ ownerDeadSince: NOW - 20_000 },
				LIMITS,
			).verdict.kind,
		).toBe("waiting");

		expect(
			evaluateWatchdogTick(
				{ now: NOW, reading: { status: "unreadable" }, ownerAlive: false },
				{ ownerDeadSince: NOW - 180_000 },
				LIMITS,
			).verdict.kind,
		).toBe("shutdown");
	});

	it("honors a longer autoShutdown for the released hold", () => {
		const tick = {
			now: NOW,
			reading: {
				status: "ok" as const,
				payload: { ts: NOW - 300_000, pid: 0, released: true },
			},
			ownerAlive: false,
		};

		expect(evaluateWatchdogTick(tick, FRESH, LIMITS).verdict.kind).toBe(
			"shutdown",
		);
		expect(
			evaluateWatchdogTick(tick, FRESH, {
				...LIMITS,
				idleTimeoutMs: 600_000,
			}).verdict.kind,
		).toBe("waiting");
	});
});
