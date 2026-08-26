import { isDockerDaemonRunning } from "../../../docker";
import * as log from "../../log";
import {
	type BuncargoContainer,
	isContainerUp,
	listBuncargoContainers,
} from "./containers";

function groupByProject(
	containers: BuncargoContainer[],
): Map<string, BuncargoContainer[]> {
	const groups = new Map<string, BuncargoContainer[]>();
	for (const container of containers) {
		const key = `${container.project}\t${container.root}`;
		const existing = groups.get(key) ?? [];
		existing.push(container);
		groups.set(key, existing);
	}
	return groups;
}

export async function handleLs(): Promise<void> {
	if (!isDockerDaemonRunning()) {
		log.fail("Docker is not running. Start Docker and try again.");
	}
	const containers = listBuncargoContainers();
	if (containers.length === 0) {
		log.info("No buncargo environments found.");
		return;
	}
	for (const group of groupByProject(containers).values()) {
		const first = group[0];
		if (!first) continue;
		const up = group.filter(isContainerUp);
		log.line(first.project);
		log.line(`  root: ${first.root || "(unknown)"}`);
		if (first.worktree) log.line(`  worktree: ${first.worktree}`);
		log.line(`  containers: ${up.length}/${group.length} up`);
		for (const item of group) {
			log.line(
				`    ${item.service || item.name}  ${item.status}  ${item.ports}`,
			);
		}
		log.line();
	}
}
