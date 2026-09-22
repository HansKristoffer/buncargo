import type { BuncargoContainer, ContainerRuntimeName } from "../types";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * Whether a container is up.
 *
 * Both runtimes spell the live state `running`, so this reads the state
 * rather than searching the human status line: `Up 3 minutes` and
 * `Exited (0) 2 hours ago` both contain a word this used to match.
 */
export function isContainerUp(container: BuncargoContainer): boolean {
	return container.state.toLowerCase() === "running";
}

/**
 * Every buncargo container on this machine, from every runtime that answers.
 *
 * The inspect commands and the sweep are machine-wide and have no config in
 * scope, so scoping them to one backend would hide containers the user started
 * from a project configured for the other.
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

/** One project's containers on one runtime: the unit `down` works on. */
export interface ContainerGroup {
	projectName: string;
	root: string;
	runtime: ContainerRuntimeName;
	containers: BuncargoContainer[];
}

export function groupBuncargoContainers(
	containers: BuncargoContainer[],
): ContainerGroup[] {
	const groups = new Map<string, ContainerGroup>();
	for (const container of containers) {
		const runtime = container.runtime ?? "docker";
		const key = `${runtime}\t${container.project}\t${container.root}`;
		let group = groups.get(key);
		if (!group) {
			group = {
				projectName: container.project,
				root: container.root,
				runtime,
				containers: [],
			};
			groups.set(key, group);
		}
		group.containers.push(container);
	}
	return [...groups.values()];
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
