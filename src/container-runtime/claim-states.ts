import type { OffsetClaim } from "../core/offset-claims";
import { type ClaimState, claimStates } from "../core/port-exhaustion";
import { readAllRuns, runLivenessAsync } from "../core/run-registry";
import { isContainerUp, listBuncargoContainers } from "./inventory";

/**
 * Whether each claim's checkout is running, holds containers, or is idle:
 * the registry with one liveness read, and one listing of every runtime that
 * answers. Paid only when a range is full and by `ports release --idle`,
 * never on a run's way up. Throws when the registry cannot be read: then no
 * claim may be read as idle.
 */
export async function readClaimStates(
	claims: Record<string, OffsetClaim>,
): Promise<Record<string, ClaimState>> {
	const runs = await readAllRuns();
	const alive = await runLivenessAsync(runs);
	const liveRoots = new Set(runs.filter(alive).map((run) => run.root));
	// A finished run still on record with services: its containers wait out
	// the idle hold, or the sweep has not seen them go yet.
	const heldRoots = new Set(
		runs
			.filter((run) => !alive(run) && run.services.length > 0)
			.map((run) => run.root),
	);
	const runningProjects = new Set(
		listBuncargoContainers()
			.filter(isContainerUp)
			.map((container) => container.project),
	);
	return claimStates(claims, { liveRoots, heldRoots, runningProjects });
}
