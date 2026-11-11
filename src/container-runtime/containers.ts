import type {
	BuncargoContainer,
	ContainerRuntimeName,
	PortContainerOwner,
} from "../types";
import { isContainerLive, isContainerServing } from "./container-state";
import type { RuntimeContainer, ServiceRuntimeState } from "./types";

/**
 * One reading of every container a runtime holds, and the answers derived
 * from it.
 *
 * A startup asks four questions of the runtime: is it up, which of this
 * project's services run and from which config, and which container holds
 * each port. Each used to be its own `docker ps` in its own format, so a warm
 * start forked the same listing three times inside the project lock. Each
 * backend now lists once into `RuntimeContainer` records, and
 * everything else is a projection of those records here.
 */

/** This project's service containers, as the startup and the watch read them. */
export function serviceStatesOf(
	containers: readonly RuntimeContainer[],
	projectName: string,
): ServiceRuntimeState[] {
	return containers.flatMap((container) => {
		const { project, service, serviceHash } = container.labels;
		if (project !== projectName || !service) return [];
		return [
			{
				service,
				state: container.state,
				running: isContainerServing(container.state),
				...(serviceHash ? { serviceHash } : {}),
				...(container.healthy === undefined
					? {}
					: { healthy: container.healthy }),
				...(container.exitCode === undefined
					? {}
					: { exitCode: container.exitCode }),
			},
		];
	});
}

/** The container behind one of a project's services, if it has one. */
export function serviceContainerOf(
	containers: readonly RuntimeContainer[],
	projectName: string,
	service: string,
): RuntimeContainer | undefined {
	return containers.find(
		(container) =>
			container.labels.project === projectName &&
			container.labels.service === service,
	);
}

/**
 * Which container publishes each host port.
 *
 * Only a live container holds its ports: a paused or restarting one keeps or
 * takes them back, while Apple lists a stopped container's configured ports
 * too. The first container listed wins a port two claim.
 */
export function portOwnersOf(
	containers: readonly RuntimeContainer[],
	/** The runtime that listed them, recorded on each owner. */
	runtime?: ContainerRuntimeName,
): Map<number, PortContainerOwner> {
	const owners = new Map<number, PortContainerOwner>();
	for (const container of containers) {
		if (!isContainerLive(container.state)) continue;
		const owner: PortContainerOwner = {
			id: container.id,
			name: container.name,
			composeProject: container.labels.composeProject,
			root: container.labels.root,
			...(runtime ? { runtime } : {}),
		};
		for (const port of container.ports)
			if (!owners.has(port)) owners.set(port, owner);
	}
	return owners;
}

/** The containers buncargo created, as the inventory commands and the sweep read them. */
export function buncargoContainersOf(
	containers: readonly RuntimeContainer[],
	runtime: ContainerRuntimeName,
): BuncargoContainer[] {
	return containers.flatMap((container) => {
		const { project, root, worktree, service } = container.labels;
		if (!project) return [];
		return [
			{
				id: container.id,
				name: container.name,
				state: container.runtimeState,
				status: container.status,
				ports: container.portsText,
				project,
				root: root ?? "",
				worktree: worktree ?? "",
				service: service ?? "",
				runtime,
			},
		];
	});
}
