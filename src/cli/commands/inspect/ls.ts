import {
	availableContainerRuntimes,
	isContainerUp,
	listBuncargoContainers,
} from "../../../container-runtime";
import type { BuncargoContainer } from "../../../types";
import * as log from "../../log";

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
	const runtimes = availableContainerRuntimes();
	if (runtimes.length === 0) {
		log.fail(
			"No container runtime is running. Start Docker or Apple container and try again.",
		);
	}
	const containers = listBuncargoContainers(runtimes);
	if (containers.length === 0) {
		log.info("No buncargo environments found.");
		return;
	}
	const multipleRuntimes = runtimes.length > 1;
	for (const group of groupByProject(containers).values()) {
		const first = group[0];
		if (!first) continue;
		const up = group.filter(isContainerUp);
		log.line(first.project);
		log.line(`  root: ${first.root || "(unknown)"}`);
		if (first.worktree) log.line(`  worktree: ${first.worktree}`);
		if (multipleRuntimes) log.line(`  runtime: ${first.runtime ?? "docker"}`);
		log.line(`  containers: ${up.length}/${group.length} up`);
		for (const item of group) {
			log.line(
				`    ${item.service || item.name}  ${item.status}  ${item.ports}`,
			);
		}
		log.line();
	}
}
