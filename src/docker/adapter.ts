import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerDownRequest,
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	EnsureRuntimeOptions,
	ExecInServiceRequest,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import { diagnoseDockerService } from "./diagnose";
import { execInDockerService } from "./exec";
import {
	listDockerBuncargoContainers,
	stopDockerContainersByIds,
} from "./inventory";
import { startContainers, stopContainers } from "./lifecycle";
import {
	dockerContainerPortOwners,
	findDockerContainerOnPort,
} from "./port-lookup";
import { ensureDockerRunning, isDockerDaemonRunning } from "./preflight";
import { dockerProjectServiceStates } from "./status";
import { listDockerVolumes, removeDockerVolumes } from "./volumes";

export interface DockerAdapterOptions {
	/** Path to the `docker` binary; falls back to a PATH lookup. */
	binary?: string;
}

/**
 * The Docker Compose backend.
 *
 * The generated compose file is the unit of work here, so `up`/`down` ignore
 * the in-memory model that Apple's backend walks.
 */
export function dockerRuntimeAdapter(
	options: DockerAdapterOptions = {},
): ContainerRuntimeAdapter {
	const { binary } = options;

	return {
		name: "docker",
		displayName: containerRuntimeDisplayName("docker"),

		isAvailable() {
			return isDockerDaemonRunning(binary);
		},

		ensureRunning(ensureOptions: EnsureRuntimeOptions = {}) {
			return ensureDockerRunning({ ...ensureOptions, binary });
		},

		up(request: ContainerUpRequest) {
			return startContainers(
				request.root,
				request.projectName,
				request.envVars,
				{ ...request, services: request.serviceNames, binary },
			);
		},

		down(request: ContainerDownRequest) {
			return stopContainers(request.root, request.projectName, {
				...request,
				binary,
			});
		},

		execInService(request: ExecInServiceRequest) {
			return execInDockerService(request, binary);
		},

		diagnoseService(request: ServiceDiagnosisRequest) {
			return diagnoseDockerService(request, binary);
		},

		// No daemon probe: the only caller that lists without knowing the daemon
		// is up is container-runtime/inventory.ts, which catches.
		list() {
			return listDockerBuncargoContainers(binary);
		},

		listVolumes() {
			return listDockerVolumes(binary);
		},

		removeVolumes(names: string[]) {
			return removeDockerVolumes(names, binary);
		},

		stopByIds(ids: string[]) {
			stopDockerContainersByIds(ids, binary);
		},

		findContainerOnPort(port: number) {
			return findDockerContainerOnPort(port, binary);
		},

		containerPortOwners() {
			return dockerContainerPortOwners(binary);
		},

		projectServiceStates(projectName: string, signal?: AbortSignal) {
			return dockerProjectServiceStates(projectName, binary, signal);
		},
	};
}
