import { formatSection } from "./style";

/**
 * Where a `buncargo dev` spent its time before the first dev server printed a
 * line.
 *
 * Off unless asked for. The point is that startup cost is paid on every run, in
 * every worktree, many times a day, so a regression in it has to be visible
 * without reaching for a profiler — and reportable by whoever (or whatever) is
 * running the command.
 */

export interface PhaseTimer {
	/** Time `operation`, recording it under `name`. */
	measure<T>(name: string, operation: () => Promise<T>): Promise<T>;
	/** Time a synchronous step. */
	measureSync<T>(name: string, operation: () => T): T;
	/** Record a phase whose duration was measured elsewhere. */
	record(name: string, durationMs: number): void;
	/** Completed phases, in the order they finished. */
	phases(): ReadonlyArray<{ name: string; durationMs: number }>;
	/** Milliseconds since the timer was created. */
	elapsedMs(): number;
	/** Print the report, or nothing when timing is off. */
	report(): void;
}

/** A timer that records nothing, so callers never branch on whether it is on. */
export function createNoopPhaseTimer(): PhaseTimer {
	return {
		measure: (_name, operation) => operation(),
		measureSync: (_name, operation) => operation(),
		record: () => {},
		phases: () => [],
		elapsedMs: () => 0,
		report: () => {},
	};
}

export function createPhaseTimer(
	deps: { now?: () => number; log?: (message: string) => void } = {},
): PhaseTimer {
	const now = deps.now ?? (() => performance.now());
	const log = deps.log ?? ((message: string) => console.log(message));
	const startedAt = now();
	const recorded: Array<{ name: string; durationMs: number }> = [];

	function record(name: string, durationMs: number): void {
		recorded.push({ name, durationMs: Math.round(durationMs) });
	}

	return {
		async measure(name, operation) {
			const start = now();
			try {
				return await operation();
			} finally {
				// Recorded even when the phase threw: a run that failed slowly is
				// exactly the one worth seeing a breakdown for.
				record(name, now() - start);
			}
		},
		measureSync(name, operation) {
			const start = now();
			try {
				return operation();
			} finally {
				record(name, now() - start);
			}
		},
		record,
		phases: () => recorded,
		elapsedMs: () => now() - startedAt,
		report() {
			const total = now() - startedAt;
			const width = recorded.reduce(
				(widest, phase) => Math.max(widest, phase.name.length),
				5,
			);
			log("");
			log(formatSection("Startup"));
			for (const phase of recorded) {
				log(
					`  ${phase.name.padEnd(width)}  ${String(phase.durationMs).padStart(6)}ms`,
				);
			}
			log(
				`  ${"total".padEnd(width)}  ${String(Math.round(total)).padStart(6)}ms`,
			);
			log("");
		},
	};
}
