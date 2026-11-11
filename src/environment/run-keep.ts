import { findCheckoutRuns, type RunEntry } from "../core/run-registry";

/** The run whose services may come down: its session, and its process when it has been stopped. */
export interface EndingRun {
	readonly projectName: string;
	/** Absent for finished runs only: then every live run of the project keeps. */
	readonly sessionId?: string;
	/** Its process, when the whole process has been stopped (`buncargo stop`). */
	readonly pid?: number;
}

/**
 * The live runs that keep a project's services up when `ending` stops: every
 * other live run of the project in the checkout. One run ending never takes
 * down another run's services; it releases its claim instead.
 *
 * Each live run claimed its containers in the registry before it started
 * them, so one still coming up is already here.
 */
export function runsKeepingServices(
	live: readonly RunEntry[],
	ending: EndingRun,
): RunEntry[] {
	return live.filter(
		(run) =>
			run.projectName === ending.projectName &&
			run.sessionId !== ending.sessionId &&
			(ending.pid === undefined || run.pid !== ending.pid),
	);
}

/**
 * {@link runsKeepingServices}, read from the registry. Call it under the
 * project's lifecycle lock, which every start takes before its containers,
 * so no run can claim them between this read and the teardown.
 */
export async function readRunsKeepingServices(
	root: string,
	ending: EndingRun,
): Promise<RunEntry[]> {
	const { live } = await findCheckoutRuns(root);
	return runsKeepingServices(live, ending);
}
