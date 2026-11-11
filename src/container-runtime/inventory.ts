import { typedSwitch } from "hanzio";
import { manualComposeDownCommand } from "../docker/binary";
import type { BuncargoContainer, ContainerRuntimeName } from "../types";
import { isContainerLive, parseContainerState } from "./container-state";
import { buncargoContainersOn } from "./containers";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * Whether a container is up: live in `isContainerLive`'s sense, so a paused
 * or restarting container still holds its stack, its ports and its claim.
 *
 * Reads the state rather than searching the human status line: `Up 3
 * minutes` and `Exited (0) 2 hours ago` both contain a word this used to
 * match.
 */
export function isContainerUp(container: BuncargoContainer): boolean {
	return isContainerLive(parseContainerState(container.state));
}

/**
 * Every buncargo container on this machine, from every runtime that answers.
 *
 * The inspect commands and the sweep are machine-wide and have no config in
 * scope, so scoping them to one backend would hide containers the user started
 * from a project configured for the other.
 */
export async function listBuncargoContainers(
	runtimes: ContainerRuntimeAdapter[] = availableContainerRuntimes(),
): Promise<BuncargoContainer[]> {
	const listings = await Promise.all(
		runtimes.map((runtime) => buncargoContainersOn(runtime).catch(() => [])),
	);
	return listings.flat();
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

/**
 * The command a person runs to remove a stack buncargo leaves alone: what its
 * own teardown does, volumes kept.
 */
export function manualDownCommand(
	group: Pick<ContainerGroup, "projectName" | "runtime" | "containers">,
): string {
	return typedSwitch(group.runtime, {
		docker: () => manualComposeDownCommand(group.projectName),
		apple: () => {
			const ids = group.containers.map((container) => container.id).join(" ");
			return `container delete --force ${ids}`;
		},
	});
}

/** Stop the given containers, each through the runtime that reported it. */
export async function stopBuncargoContainers(
	containers: BuncargoContainer[],
	runtimes: ContainerRuntimeAdapter[] = availableContainerRuntimes(),
): Promise<void> {
	for (const runtime of runtimes) {
		const ids = containers
			.filter((container) => (container.runtime ?? "docker") === runtime.name)
			.map((container) => container.id);
		await runtime.stop(ids);
	}
}
