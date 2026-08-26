import type { BuncargoContainer } from "../types";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * Whether a container is up, across both runtimes' status vocabularies.
 *
 * Docker reports `Up 3 minutes`; Apple reports `running`.
 */
export function isContainerUp(container: BuncargoContainer): boolean {
	const status = container.status.toLowerCase();
	return status.includes("up") || status.includes("running");
}

/**
 * Every buncargo container on this machine, from every runtime that answers.
 *
 * The inspect commands and `dev --down --all` are machine-wide and have no
 * config in scope, so scoping them to one backend would hide containers the
 * user started from a project configured for the other.
 */
export function listBuncargoContainers(
	runtimes: ContainerRuntimeAdapter[] = availableContainerRuntimes(),
): BuncargoContainer[] {
	return runtimes.flatMap((runtime) => {
		try {
			return runtime.list();
		} catch {
			return [];
		}
	});
}

/** Stop the given containers, each through the runtime that reported it. */
export function stopBuncargoContainers(
	containers: BuncargoContainer[],
	runtimes: ContainerRuntimeAdapter[] = availableContainerRuntimes(),
): void {
	for (const runtime of runtimes) {
		const ids = containers
			.filter((container) => (container.runtime ?? "docker") === runtime.name)
			.map((container) => container.id);
		if (ids.length > 0) runtime.stopByIds(ids);
	}
}
