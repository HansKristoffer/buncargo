import {
	isContainerUp,
	type SweepResult,
	sweepOrphanedContainers,
} from "../../../container-runtime";
import { getRunsPath } from "../../../core/run-registry";
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
	// Sweep first, so what is listed is what is actually still in use. The
	// sweep lists every runtime anyway, so its listing is the one shown: no
	// probing beforehand and no second listing after.
	let result: SweepResult;
	try {
		result = await sweepOrphanedContainers();
	} catch (error) {
		log.fail(
			`Could not read ${getRunsPath()}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (result.answered.length === 0) {
		log.fail(
			"No container runtime is running. Start Docker or Apple container and try again.",
		);
	}
	for (const stack of result.swept)
		log.info(`Removed ${stack.projectName} (${stack.root}): ${stack.reason}`);
	for (const failure of result.failed)
		log.warn(`Could not remove ${failure.projectName}: ${failure.error}`);

	if (result.remaining.length === 0) {
		log.info("No buncargo environments found.");
		return;
	}
	const now = Date.now();
	const multipleRuntimes = result.answered.length > 1;

	for (const group of result.remaining) {
		const first = group.containers[0];
		if (!first) continue;
		const up = group.containers.filter(isContainerUp);
		// The registry says who each stack belongs to, which the labels cannot:
		// whether a run is still using it, or it is only being held for the next.
		const owners = result.runs.filter(
			(run) => run.projectName === group.projectName && run.root === group.root,
		);
		const live = owners.find((run) => result.liveSessions.has(run.sessionId));
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
