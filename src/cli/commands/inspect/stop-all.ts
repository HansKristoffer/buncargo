import {
	availableContainerRuntimes,
	type ContainerRuntimeAdapter,
	groupBuncargoContainers,
	listBuncargoContainers,
} from "../../../container-runtime";
import * as log from "../../log";

/**
 * Remove every buncargo container stack on this machine, whatever started it.
 *
 * Backs `dev --down --all`, which has no project config in scope, so it asks
 * every runtime that is up rather than assuming the one this repo prefers.
 * `down`, not `stop`: a stopped container is still a container, and this is
 * the command people reach for to get a clean machine.
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
	log.info(
		`Removing ${groups.length} container stack${groups.length === 1 ? "" : "s"}...`,
	);
	for (const group of groups) {
		const runtime = runtimes.find((entry) => entry.name === group.runtime);
		if (!runtime) continue;
		await runtime.down({
			root: group.root,
			projectName: group.projectName,
			verbose: false,
		});
		log.line(`  ${group.projectName}  ${group.root}`);
	}
	log.done("All buncargo environments removed");
}
