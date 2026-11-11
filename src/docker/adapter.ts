import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerRuntimeAdapter,
	EnsureRuntimeOptions,
} from "../container-runtime/types";
import { listDockerContainersAsync } from "./containers";
import { dockerInteractiveExecArgv, execInDockerService } from "./exec";
import { stopDockerContainersByIds } from "./inventory";
import { startContainers, stopContainers } from "./lifecycle";
import { dockerContainerLogs } from "./logs";
import {
	dockerAvailability,
	dockerDaemonState,
	ensureDockerRunning,
} from "./preflight";
import {
	listDockerComposeProjectResources,
	removeDockerComposeProjectResource,
} from "./project-resources";
import {
	listDockerVolumes,
	readDockerVolumeSizes,
	removeDockerVolumes,
} from "./volumes";

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
		capabilities: {
			jobExitCodes: true,
			hostPortProbe: true,
			composeProjectResources: true,
		},

		availability() {
			return dockerAvailability(dockerDaemonState(binary));
		},

		ensureRunning(ensureOptions: EnsureRuntimeOptions = {}) {
			return ensureDockerRunning({ ...ensureOptions, binary });
		},

		containers(signal) {
			return listDockerContainersAsync(binary, { signal });
		},

		logs(request) {
			return dockerContainerLogs(request, binary);
		},

		up(request) {
			return startContainers(
				request.root,
				request.projectName,
				request.envVars,
				// No `--wait`: callers poll readiness against the published ports,
				// the same on both backends, and Compose's wait would be a second,
				// weaker copy of it.
				{ ...request, services: request.serviceNames, binary, wait: false },
			);
		},

		down(request) {
			return stopContainers(request.root, request.projectName, {
				...request,
				binary,
			});
		},

		stop(ids) {
			return stopDockerContainersByIds(ids, binary);
		},

		exec(request) {
			return execInDockerService(request, binary);
		},

		execArgv(request) {
			return dockerInteractiveExecArgv(request, binary);
		},

		listVolumes() {
			return listDockerVolumes(binary);
		},

		volumeSizes() {
			return readDockerVolumeSizes(binary);
		},

		removeVolumes(names) {
			return removeDockerVolumes(names, binary);
		},

		async listComposeProjectResources() {
			return listDockerComposeProjectResources(binary);
		},

		removeComposeProjectResource(kind, name) {
			return removeDockerComposeProjectResource(kind, name, binary);
		},
	};
}
