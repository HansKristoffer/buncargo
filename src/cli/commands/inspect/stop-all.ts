import {
	availableContainerRuntimes,
	type ContainerRuntimeAdapter,
	groupBuncargoContainers,
	isKnownStack,
	listBuncargoContainers,
	manualDownCommand,
} from "../../../container-runtime";
import { readAllOffsetClaims } from "../../../core/offset-claims";
import {
	recordRemovals,
	removalActor,
	removalOwner,
} from "../../../core/removal-log";
import {
	getRunsPath,
	type RunEntry,
	readAllRuns,
} from "../../../core/run-registry";
import * as log from "../../log";

/**
 * Remove every buncargo container stack this user's buncargo started.
 *
 * Backs `dev --down --all`, which has no project config in scope, so it asks
 * every runtime that is up rather than assuming the one this repo prefers.
 * `down`, not `stop`: a stopped container is still a container, and this is
 * the command people reach for to get a clean machine.
 *
 * Only stacks a run or port claim in this user's `~/.buncargo` names, the same
 * rule the sweep follows: on a daemon several users share, another user's
 * stacks are listed here too, live runs' included. Those are named with the
 * command that removes each, for whoever owns them.
 */
export async function stopAllBuncargoEnvironments(
	runtimes: ContainerRuntimeAdapter[] = availableContainerRuntimes(),
): Promise<void> {
	if (runtimes.length === 0) {
		log.info("No container runtime is running. Nothing to stop.");
		return;
	}
	const groups = groupBuncargoContainers(listBuncargoContainers(runtimes));
	if (groups.length === 0) {
		log.info("No buncargo containers.");
		return;
	}

	// Unread, the registry would leave every stack of this user's looking like
	// another user's: say so instead of reporting a clean machine.
	let runs: RunEntry[];
	try {
		runs = await readAllRuns();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not read ${getRunsPath()}, so nothing was removed: ${reason}. Fix or move the file, then run again.`,
		);
	}
	const claims = readAllOffsetClaims();
	const ours = groups.filter((group) => isKnownStack(group, runs, claims));
	const others = groups.filter((group) => !ours.includes(group));

	if (ours.length > 0)
		log.info(
			`Removing ${ours.length} container stack${ours.length === 1 ? "" : "s"}...`,
		);
	const by = removalActor();
	for (const group of ours) {
		const runtime = runtimes.find((entry) => entry.name === group.runtime);
		if (!runtime) continue;
		await runtime.down({
			root: group.root,
			projectName: group.projectName,
			verbose: false,
		});
		await recordRemovals([
			{
				at: new Date().toISOString(),
				projectName: group.projectName,
				root: group.root,
				runtime: group.runtime,
				reason: "dev --down --all removed every stack of this user's",
				owner: removalOwner(
					runs.find(
						(run) =>
							run.projectName === group.projectName && run.root === group.root,
					),
				),
				by,
			},
		]);
		log.line(`  ${group.projectName}  ${group.root}`);
	}

	if (others.length > 0) {
		log.warn(
			`Left ${others.length} stack${others.length === 1 ? "" : "s"} this user's buncargo did not start (another user's, or from state that was wiped). Remove one by hand only if it is really orphaned; its volumes stay:`,
		);
		for (const group of others)
			log.line(
				`  ${group.projectName}  ${group.root || "(no checkout recorded)"}\n    ${manualDownCommand(group)}`,
			);
	}
	if (ours.length > 0)
		log.done("All of this user's buncargo environments removed");
	else log.info("No buncargo containers of this user's.");
}
