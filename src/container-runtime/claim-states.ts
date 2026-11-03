import type { OffsetClaim } from "../core/offset-claims";
import { type ClaimState, claimStates } from "../core/port-exhaustion";
import { readCheckoutRuns } from "../core/run-registry";
import { isContainerUp } from "./inventory";
import { availableContainerRuntimes } from "./resolve";

/**
 * Whether each claim's checkout is running, holds containers, or is idle:
 * the registry with one liveness read, and one listing of every runtime that
 * is up. Paid only when a range is full and by `ports`/`ports release
 * --idle`, never on a run's way up.
 *
 * Throws when the registry cannot be read or a runtime that is up fails to
 * list, rather than reading its containers as none: then no claim may be
 * read as idle. A runtime that is down runs no container.
 */
export async function readClaimStates(
	claims: Record<string, OffsetClaim>,
): Promise<Record<string, ClaimState>> {
	const { live, held } = await readCheckoutRuns(() => true);
	const runningProjects = new Set(
		availableContainerRuntimes()
			.flatMap((runtime) => runtime.list())
			.filter(isContainerUp)
			.map((container) => container.project),
	);
	return claimStates(claims, {
		liveRoots: new Set(live.map((run) => run.root)),
		heldRoots: new Set(held.map((run) => run.root)),
		runningProjects,
	});
}
