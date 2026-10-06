import { homedir } from "node:os";
import { join } from "node:path";
import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerDownRequest,
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	EnsureRuntimeOptions,
	ExecInServiceRequest,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import type { ContainerRuntimeName } from "../types";
import type { DockerBinary } from "./binary";
import { diagnoseDockerService } from "./diagnose";
import { dockerInteractiveExecArgv, execInDockerService } from "./exec";
import {
	listDockerBuncargoContainers,
	stopDockerContainersByIds,
} from "./inventory";
import { startContainers, stopContainers } from "./lifecycle";
import {
	dockerContainerPortOwners,
	dockerContainerPortOwnersAsync,
	findDockerContainerOnPort,
} from "./port-lookup";
import { ensureDockerRunning, isDockerDaemonRunning } from "./preflight";
import {
	listDockerComposeProjectResources,
	removeDockerComposeProjectResource,
} from "./project-resources";
import { dockerProjectServiceStates } from "./status";
import { listDockerVolumes, removeDockerVolumes } from "./volumes";

export interface DockerAdapterOptions {
	/** Path to the `docker` binary; falls back to a PATH lookup. */
	binary?: string;
	/**
	 * `"orbstack"` pins every command to OrbStack's engine. Default `"docker"`:
	 * the engine of Docker's current context.
	 */
	engine?: "docker" | "orbstack";
}

/** OrbStack's own Docker socket, which exists whether or not a context names it. */
export function orbstackDockerSocket(): string {
	return join(homedir(), ".orbstack", "run", "docker.sock");
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
	const name = options.engine ?? "docker";
	const binary: DockerBinary | undefined =
		name === "orbstack"
			? { binary: options.binary, host: `unix://${orbstackDockerSocket()}` }
			: options.binary;
	// Listings say which runtime they came from; this backend serves two.
	const fromThisRuntime = <T extends { runtime?: ContainerRuntimeName }>(
		items: T[],
	): T[] => items.map((item) => ({ ...item, runtime: name }));

	return {
		name,
		displayName: containerRuntimeDisplayName(name),

		isAvailable() {
			return isDockerDaemonRunning(binary);
		},

		ensureRunning(ensureOptions: EnsureRuntimeOptions = {}) {
			return ensureDockerRunning({
				...ensureOptions,
				binary,
				...(name === "orbstack" ? { engine: "orbstack" as const } : {}),
			});
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

		interactiveExecArgv(request) {
			return dockerInteractiveExecArgv(request, binary);
		},

		diagnoseService(request: ServiceDiagnosisRequest) {
			return diagnoseDockerService(request, binary);
		},

		// No daemon probe: the only caller that lists without knowing the daemon
		// is up is container-runtime/inventory.ts, which catches.
		list() {
			return fromThisRuntime(listDockerBuncargoContainers(binary));
		},

		async listVolumes() {
			return fromThisRuntime(await listDockerVolumes(binary));
		},

		removeVolumes(names: string[]) {
			return removeDockerVolumes(names, binary);
		},

		listComposeProjectResources() {
			return listDockerComposeProjectResources(binary);
		},

		removeComposeProjectResource(kind, name) {
			return removeDockerComposeProjectResource(kind, name, binary);
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

		containerPortOwnersAsync(signal?: AbortSignal) {
			return dockerContainerPortOwnersAsync(binary, signal);
		},

		projectServiceStates(projectName: string, signal?: AbortSignal) {
			return dockerProjectServiceStates(projectName, binary, signal);
		},
	};
}
