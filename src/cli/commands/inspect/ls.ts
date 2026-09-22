import {
	availableContainerRuntimes,
	groupBuncargoContainers,
	isContainerUp,
	listBuncargoContainers,
	sweepOrphanedContainers,
} from "../../../container-runtime";
import { isRunAlive, readAllRuns } from "../../../core/run-registry";
import * as log from "../../log";

/** "held, 2m left" for a finished run, or nothing while one is live. */
function describeHold(
	releasedAt: string,
	idleTimeoutMs: number | undefined,
	now: number,
): string {
	if (idleTimeoutMs === undefined) return "held until this checkout is removed";
	const left = Date.parse(releasedAt) + idleTimeoutMs - now;
	if (left <= 0) return "held, removal due";
	return `held, ${Math.ceil(left / 60_000)}m left`;
}

export async function handleLs(): Promise<void> {
	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.fail(
			"No container runtime is running. Start Docker or Apple container and try again.",
		);
	}
	// Sweep first, so what is listed is what is actually still in use.
	const { swept, failed } = await sweepOrphanedContainers({ runtimes });
	for (const stack of swept)
		log.info(`Removed ${stack.projectName} (${stack.root}): ${stack.reason}`);
	for (const failure of failed)
		log.warn(`Could not remove ${failure.projectName}: ${failure.error}`);

	const groups = groupBuncargoContainers(listBuncargoContainers(runtimes));
	if (groups.length === 0) {
		log.info("No buncargo environments found.");
		return;
	}
	// The registry says who each stack belongs to, which the labels cannot:
	// whether a run is still using it, or it is only being held for the next.
	const runs = await readAllRuns();
	const now = Date.now();
	const multipleRuntimes = runtimes.length > 1;

	for (const group of groups) {
		const first = group.containers[0];
		if (!first) continue;
		const up = group.containers.filter(isContainerUp);
		const owners = runs.filter(
			(run) => run.projectName === group.projectName && run.root === group.root,
		);
		const live = owners.find(isRunAlive);
		const released = owners
			.filter((run) => run.releasedAt !== undefined)
			.sort((a, b) =>
				(b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""),
			)[0];

		log.line(group.projectName);
		log.line(`  root: ${group.root || "(unknown)"}`);
		if (first.worktree) log.line(`  worktree: ${first.worktree}`);
		if (multipleRuntimes) log.line(`  runtime: ${group.runtime}`);
		if (live) log.line(`  run: active, pid ${live.pid}`);
		else if (released?.releasedAt)
			log.line(
				`  run: ${describeHold(released.releasedAt, released.idleTimeoutMs, now)}`,
			);
		log.line(`  containers: ${up.length}/${group.containers.length} up`);
		for (const item of group.containers) {
			log.line(
				`    ${item.service || item.name}  ${item.status}  ${item.ports}`,
			);
		}
		log.line();
	}
}
