import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerDownRequest,
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	EnsureRuntimeOptions,
	ExecInServiceRequest,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import { DEFAULT_DOCKER_BINARY, runDocker } from "./binary";
import { getComposeArgs } from "./compose-command";
import { diagnoseDockerService } from "./diagnose";
import {
	listDockerBuncargoContainers,
	stopDockerContainersByIds,
} from "./inventory";
import { startContainers, stopContainers } from "./lifecycle";
import { findDockerContainerOnPort } from "./port-lookup";
import { ensureDockerRunning, isDockerDaemonRunning } from "./preflight";
import { areServicesRunning } from "./status";

/**
 * Run a probe inside a service container.
 *
 * Spawned as argv rather than through a shell so the command reaches the
 * container exactly as the caller wrote it, matching the Apple backend.
 */
function execInService(
	request: ExecInServiceRequest,
	binary: string = DEFAULT_DOCKER_BINARY,
): boolean {
	return runDocker(
		binary,
		[
			...getComposeArgs({
				projectName: request.projectName,
				composeFile: request.composeFile,
			}),
			"exec",
			"-T",
			request.serviceName,
			...request.command,
		],
		{ cwd: request.root },
	).ok;
}

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
				wait: request.wait,
				composeFile: request.composeFile,
				services: request.serviceNames,
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
			return execInService(request, binary);
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
	};
}
