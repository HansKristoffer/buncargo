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
import { appleDown, appleStopByIds, appleUp } from "./lifecycle";
import {
	ensureAppleContainerRunning,
	isAppleContainerSystemRunning,
} from "./preflight";
import { containerNameFor } from "./run-plan";
import {
	appleContainerPortOwners,
	appleProjectServiceStates,
	diagnoseAppleService,
	findAppleContainerOnPort,
	listAppleBuncargoContainers,
} from "./status";
import { listAppleVolumes, removeAppleVolumes } from "./volumes";

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
			return appleUp(cli, request);
		},

		down(request: ContainerDownRequest) {
			return appleDown(cli, request);
		},

		async execInService(request: ExecInServiceRequest) {
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

		diagnoseService(request: ServiceDiagnosisRequest) {
			return diagnoseAppleService(cli, request);
		},

		list() {
			if (!isAppleContainerSystemRunning(cli)) return [];
			return listAppleBuncargoContainers(cli);
		},

		listVolumes() {
			if (!isAppleContainerSystemRunning(cli)) return Promise.resolve([]);
			return listAppleVolumes(cli);
		},

		removeVolumes(names: string[]) {
			return removeAppleVolumes(cli, names);
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

		projectServiceStates(projectName: string, signal?: AbortSignal) {
			return appleProjectServiceStates(cli, projectName, signal);
		},
	};
}
