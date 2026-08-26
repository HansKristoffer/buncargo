/**
 * When the watchdog may take a container stack down.
 *
 * Pure so the policy can be tested without spawning Docker or waiting minutes.
 * The distinction that matters is *why* the owner is gone: a crash should be
 * cleaned up quickly, while a deliberate exit has to leave room for the
 * developer to start the next run before anything is destroyed.
 */

import type { HeartbeatPayload } from "./watchdog";

/** What the runner found on disk this tick. */
export type HeartbeatReading =
	| { status: "missing" }
	| { status: "unreadable" }
	| { status: "ok"; payload: HeartbeatPayload };

export interface WatchdogTick {
	now: number;
	reading: HeartbeatReading;
	/** Whether the PID recorded in the heartbeat is still running. */
	ownerAlive: boolean;
}

export interface WatchdogMemory {
	/** First tick at which the owner looked gone, or null while it is healthy. */
	ownerDeadSince: number | null;
}

export interface WatchdogLimits {
	/** Backstop for an owner that left on purpose, or is idle but alive-ish. */
	idleTimeoutMs: number;
	/** Grace for an owner that vanished without releasing. */
	ownerDeadGraceMs: number;
}

export type WatchdogVerdict =
	| { kind: "healthy" }
	| { kind: "waiting" }
	| { kind: "shutdown"; reason: string };

export interface WatchdogEvaluation {
	verdict: WatchdogVerdict;
	memory: WatchdogMemory;
}

function seconds(ms: number): number {
	return Math.ceil(ms / 1000);
}

export function evaluateWatchdogTick(
	tick: WatchdogTick,
	memory: WatchdogMemory,
	limits: WatchdogLimits,
): WatchdogEvaluation {
	const { now, reading } = tick;
	const ownerDeadSince = memory.ownerDeadSince ?? now;

	switch (reading.status) {
		case "missing": {
			// Someone removed the file, so there is no release to honor.
			const deadFor = now - ownerDeadSince;
			if (deadFor >= limits.ownerDeadGraceMs) {
				return {
					verdict: {
						kind: "shutdown",
						reason: `heartbeat file missing for ${seconds(deadFor)}s`,
					},
					memory: { ownerDeadSince },
				};
			}
			return { verdict: { kind: "waiting" }, memory: { ownerDeadSince } };
		}

		case "unreadable": {
			// A torn write should not condemn the stack, but a permanently
			// corrupt file must not keep the watchdog alive forever either.
			const deadFor = now - ownerDeadSince;
			if (deadFor >= limits.idleTimeoutMs) {
				return {
					verdict: {
						kind: "shutdown",
						reason: `heartbeat unreadable for ${seconds(deadFor)}s`,
					},
					memory: { ownerDeadSince },
				};
			}
			return { verdict: { kind: "waiting" }, memory: { ownerDeadSince } };
		}

		case "ok": {
			const { payload } = reading;

			if (payload.released) {
				// A clean exit: hold the stack for the full idle backstop so a
				// restart reuses these containers instead of recreating them.
				const idleFor = now - payload.ts;
				if (idleFor >= limits.idleTimeoutMs) {
					return {
						verdict: {
							kind: "shutdown",
							reason: `released ${seconds(idleFor)}s ago with no new owner`,
						},
						memory: { ownerDeadSince },
					};
				}
				return { verdict: { kind: "waiting" }, memory: { ownerDeadSince } };
			}

			if (tick.ownerAlive) {
				return {
					verdict: { kind: "healthy" },
					memory: { ownerDeadSince: null },
				};
			}

			const deadFor = now - ownerDeadSince;
			const idleFor = now - payload.ts;
			if (
				deadFor >= limits.ownerDeadGraceMs ||
				idleFor > limits.idleTimeoutMs
			) {
				return {
					verdict: {
						kind: "shutdown",
						reason: `owner gone (dead ${seconds(deadFor)}s, idle ${seconds(idleFor)}s)`,
					},
					memory: { ownerDeadSince },
				};
			}
			return { verdict: { kind: "waiting" }, memory: { ownerDeadSince } };
		}

		default: {
			const _exhaustive: never = reading;
			void _exhaustive;
			return { verdict: { kind: "waiting" }, memory: { ownerDeadSince } };
		}
	}
}
