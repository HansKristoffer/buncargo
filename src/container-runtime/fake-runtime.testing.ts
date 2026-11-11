import type { BuncargoContainer } from "../types";
import { parseContainerState } from "./container-state";
import type {
	ContainerLabels,
	ContainerRuntimeAdapter,
	RuntimeContainer,
} from "./types";

/**
 * An adapter that holds no containers and answers every call as a healthy,
 * empty runtime would. Tests override the members they observe.
 */
export function fakeRuntime(
	overrides: Partial<ContainerRuntimeAdapter> = {},
): ContainerRuntimeAdapter {
	return {
		name: "docker",
		displayName: "Docker",
		capabilities: {
			jobExitCodes: true,
			hostPortProbe: true,
			composeProjectResources: true,
		},
		availability: () => ({ state: "up" }),
		ensureRunning: async () => {},
		containers: async () => [],
		logs: async () => "",
		up: async () => {},
		down: async () => {},
		stop: async () => {},
		exec: async () => false,
		execArgv: async () => undefined,
		listVolumes: async () => [],
		volumeSizes: async () => new Map(),
		removeVolumes: async () => [],
		listComposeProjectResources: async () => ({
			containers: [],
			volumes: [],
			networks: [],
		}),
		removeComposeProjectResource: async () => undefined,
		...overrides,
	};
}

/** Apple's capabilities, on {@link fakeRuntime}. */
export function fakeAppleRuntime(
	overrides: Partial<ContainerRuntimeAdapter> = {},
): ContainerRuntimeAdapter {
	return fakeRuntime({
		name: "apple",
		displayName: "Apple container",
		capabilities: {
			jobExitCodes: false,
			hostPortProbe: false,
			composeProjectResources: false,
		},
		...overrides,
	});
}

/** One listed container, running unless `state` says otherwise. */
export function runtimeContainer(
	container: Partial<Omit<RuntimeContainer, "state">> & {
		state?: string;
		labels?: ContainerLabels;
	} = {},
): RuntimeContainer {
	const runtimeState = container.state ?? "running";
	return {
		id: "c1",
		name: container.id ?? "c1",
		status: runtimeState,
		ports: [],
		portsText: "",
		labels: {},
		...container,
		state: parseContainerState(runtimeState),
		runtimeState,
	};
}

/** The listing record an inventory row was read from. */
export function listedAs(container: BuncargoContainer): RuntimeContainer {
	return runtimeContainer({
		id: container.id,
		name: container.name,
		state: container.state,
		status: container.status,
		portsText: container.ports,
		labels: {
			composeProject: container.project,
			project: container.project,
			...(container.root ? { root: container.root } : {}),
			...(container.worktree ? { worktree: container.worktree } : {}),
			...(container.service ? { service: container.service } : {}),
		},
	});
}
