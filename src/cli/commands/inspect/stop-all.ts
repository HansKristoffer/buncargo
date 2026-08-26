import { execSync } from "node:child_process";
import { isDockerDaemonRunning } from "../../../docker";
import * as log from "../../log";
import { isContainerUp, listBuncargoContainers } from "./containers";

export async function stopAllBuncargoEnvironments(): Promise<void> {
	if (!isDockerDaemonRunning()) {
		log.info("Docker is not running. Nothing to stop.");
		return;
	}
	const running = listBuncargoContainers().filter(isContainerUp);
	if (running.length === 0) {
		log.info("No running buncargo containers.");
		return;
	}
	const ids = running.map((item) => item.id);
	log.info(`Stopping ${ids.length} container${ids.length === 1 ? "" : "s"}...`);
	execSync(`docker stop ${ids.join(" ")}`, { stdio: "inherit" });
	log.done("All buncargo environments stopped");
}
