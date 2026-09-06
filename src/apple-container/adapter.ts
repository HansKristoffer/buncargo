import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerDownRequest,
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	EnsureRuntimeOptions,
	ExecInServiceRequest,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import type { AppleContainerCli } from "./cli";
import { createAppleContainerCli, runAppleAsync } from "./cli";
import {
	appleDown,
	appleDownAsync,
	appleStopByIds,
	appleUp,
	appleUpAsync,
} from "./lifecycle";
import {
	ensureAppleContainerRunning,
	isAppleContainerSystemRunning,
} from "./preflight";
import { containerNameFor } from "./run-plan";
import {
	appleContainerPortOwners,
	appleProjectServiceStates,
	appleProjectServiceStatesAsync,
	areAppleServicesRunning,
	diagnoseAppleService,
	diagnoseAppleServiceAsync,
	findAppleContainerOnPort,
	listAppleBuncargoContainers,
} from "./status";

export interface AppleContainerAdapterOptions {
	/** Path to the `container` binary; falls back to a PATH lookup. */
	binary?: string;
	/** Injected for tests; the real one shells out via execSync. */
	cli?: AppleContainerCli;
}

export function appleContainerRuntimeAdapter(
	options: AppleContainerAdapterOptions = {},
): ContainerRuntimeAdapter {
	const cli =
		options.cli ?? createAppleContainerCli({ binary: options.binary });

	return {
		name: "apple",
		displayName: containerRuntimeDisplayName("apple"),

		isAvailable() {
			return isAppleContainerSystemRunning(cli);
		},

		ensureRunning(ensureOptions: EnsureRuntimeOptions = {}) {
			return ensureAppleContainerRunning(cli, ensureOptions);
		},

		up(request: ContainerUpRequest) {
			appleUp(cli, request);
		},

		upAsync(request: ContainerUpRequest) {
			return appleUpAsync(cli, request);
		},
		downAsync(request: ContainerDownRequest) {
			return appleDownAsync(cli, request);
		},
		down(request: ContainerDownRequest) {
			appleDown(cli, request);
		},

		async areServicesRunning(projectName: string, serviceNames: string[]) {
			return areAppleServicesRunning(cli, projectName, serviceNames);
		},

		execInService(request: ExecInServiceRequest) {
			const containerName = containerNameFor(
				request.projectName,
				request.serviceName,
			);
			return cli.run(["exec", containerName, ...request.command]).ok;
		},

		async execInServiceAsync(request: ExecInServiceRequest) {
			return (
				await runAppleAsync(
					cli,
					[
						"exec",
						containerNameFor(request.projectName, request.serviceName),
						...request.command,
					],
					{ signal: request.signal, timeoutMs: request.timeoutMs ?? 2000 },
				)
			).ok;
		},
		diagnoseServiceAsync(request: ServiceDiagnosisRequest) {
			return diagnoseAppleServiceAsync(cli, request);
		},
		diagnoseService(request: ServiceDiagnosisRequest) {
			return diagnoseAppleService(cli, request);
		},

		list() {
			if (!isAppleContainerSystemRunning(cli)) return [];
			return listAppleBuncargoContainers(cli);
		},

		stopByIds(ids: string[]) {
			appleStopByIds(cli, ids);
		},

		findContainerOnPort(port: number) {
			return findAppleContainerOnPort(cli, port);
		},

		containerPortOwners() {
			return appleContainerPortOwners(cli);
		},

		projectServiceStatesAsync(projectName: string, signal?: AbortSignal) {
			return appleProjectServiceStatesAsync(cli, projectName, signal);
		},
		projectServiceStates(projectName: string) {
			return appleProjectServiceStates(cli, projectName);
		},
	};
}
