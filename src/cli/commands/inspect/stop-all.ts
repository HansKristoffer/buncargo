import {
	availableContainerRuntimes,
	isContainerUp,
	listBuncargoContainers,
	stopBuncargoContainers,
} from "../../../container-runtime";
import * as log from "../../log";

/**
 * Stop every buncargo container on this machine, whatever started it.
 *
 * Backs `dev --down --all`, which has no project config in scope, so it asks
 * every runtime that is up rather than assuming the one this repo prefers.
 */
export async function stopAllBuncargoEnvironments(): Promise<void> {
	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.info("No container runtime is running. Nothing to stop.");
		return;
	}
	const running = listBuncargoContainers(runtimes).filter(isContainerUp);
	if (running.length === 0) {
		log.info("No running buncargo containers.");
		return;
	}
	log.info(
		`Stopping ${running.length} container${running.length === 1 ? "" : "s"}...`,
	);
	stopBuncargoContainers(running, runtimes);
	log.done("All buncargo environments stopped");
}
