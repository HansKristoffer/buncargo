import { CHECKOUT_HOLD, LIVE, type RunEntry } from "./run-registry";

/**
 * A pid above every platform's limit (Linux caps at 2^22, macOS lower), so no
 * process ever has it: a run entry with it reads as owned by a dead process.
 */
export const DEAD_PID = 2 ** 22 + 1;

/**
 * A live run of `demo` at `/repo` with no apps or services, owned by a dead
 * pid and started now. Tests override the fields they observe.
 */
export function runEntry(extra: Partial<RunEntry> = {}): RunEntry {
	const now = new Date().toISOString();
	return {
		sessionId: "s1",
		projectPrefix: "demo",
		projectName: "demo",
		root: "/repo",
		worktree: null,
		pid: DEAD_PID,
		startedAt: now,
		updatedAt: now,
		lifecycle: LIVE,
		hold: CHECKOUT_HOLD,
		hosts: null,
		cli: { program: "bun" },
		apps: [],
		services: [],
		...extra,
	};
}
