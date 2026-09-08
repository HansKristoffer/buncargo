import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerDownRequest,
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	EnsureRuntimeOptions,
	ExecInServiceRequest,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import { diagnoseDockerService, diagnoseDockerServiceAsync } from "./diagnose";
import { execInDockerService, execInDockerServiceAsync } from "./exec";
import {
	listDockerBuncargoContainers,
	stopDockerContainersByIds,
} from "./inventory";
import {
	startContainers,
	startContainersAsync,
	stopContainers,
	stopContainersAsync,
} from "./lifecycle";
import {
	dockerContainerPortOwners,
	findDockerContainerOnPort,
} from "./port-lookup";
import { ensureDockerRunning, isDockerDaemonRunning } from "./preflight";
import {
	areServicesRunning,
	dockerProjectServiceStates,
	dockerProjectServiceStatesAsync,
} from "./status";

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
			startContainers(request.root, request.projectName, request.envVars, {
				verbose: request.verbose,
				noDeps: request.noDeps,
				wait: request.wait,
				composeFile: request.composeFile,
				services: request.serviceNames,
				binary,
			});
		},

		upAsync(request: ContainerUpRequest) {
			return startContainersAsync(
				request.root,
				request.projectName,
				request.envVars,
				{ ...request, services: request.serviceNames, binary },
			);
		},
		downAsync(request: ContainerDownRequest) {
			return stopContainersAsync(request.root, request.projectName, {
				...request,
				binary,
			});
		},
		down(request: ContainerDownRequest) {
			stopContainers(request.root, request.projectName, {
				verbose: request.verbose,
				removeVolumes: request.removeVolumes,
				composeFile: request.composeFile,
				binary,
			});
		},

		areServicesRunning(projectName: string, serviceNames: string[]) {
			return areServicesRunning(projectName, serviceNames, binary);
		},

		execInService(request: ExecInServiceRequest) {
			return execInDockerService(request, binary);
		},

		execInServiceAsync(request: ExecInServiceRequest) {
			return execInDockerServiceAsync(request, binary);
		},
		diagnoseServiceAsync(request: ServiceDiagnosisRequest) {
			return diagnoseDockerServiceAsync(request, binary);
		},
		diagnoseService(request: ServiceDiagnosisRequest) {
			return diagnoseDockerService(request, binary);
		},

		// No daemon probe: the only caller that lists without knowing the daemon
		// is up is container-runtime/inventory.ts, which catches.
		list() {
			return listDockerBuncargoContainers(binary);
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

		projectServiceStatesAsync(projectName: string, signal?: AbortSignal) {
			return dockerProjectServiceStatesAsync(projectName, binary, signal);
		},
		projectServiceStates(projectName: string) {
			return dockerProjectServiceStates(projectName, binary);
		},
	};
}
