import { containerRuntimeDisplayName } from "../container-runtime/names";
import type {
	ContainerRuntimeAdapter,
	EnsureRuntimeOptions,
} from "../container-runtime/types";
import type { AppleContainerCli } from "./cli";
import {
	APPLE_CONTAINER_COMMAND,
	createAppleContainerCli,
	runAppleAsync,
} from "./cli";
import { appleDown, appleStopByIds, appleUp } from "./lifecycle";
import {
	appleContainerAvailability,
	ensureAppleContainerRunning,
	isAppleContainerSupported,
} from "./preflight";
import { containerNameFor } from "./run-plan";
import {
	appleContainerLogs,
	appleContainers,
	isAppleServiceRunning,
} from "./status";
import { listAppleVolumes, removeAppleVolumes } from "./volumes";

export interface AppleContainerAdapterOptions {
	/** Path to the `container` binary; falls back to a PATH lookup. */
	binary?: string;
	/** Injected for tests; the real one shells out via execSync. */
	cli?: AppleContainerCli;
}

const NO_COMPOSE_PROJECTS =
	"Apple container records no Compose project on volumes and networks.";

export function appleContainerRuntimeAdapter(
	options: AppleContainerAdapterOptions = {},
): ContainerRuntimeAdapter {
	const cli =
		options.cli ?? createAppleContainerCli({ binary: options.binary });

	return {
		name: "apple",
		displayName: containerRuntimeDisplayName("apple"),
		capabilities: {
			// A running process is not proof of successful job completion. Until
			// Apple supplies reliable exit codes, accepting a job would weaken its
			// contract.
			jobExitCodes: false,
			// Its port forwarder accepts a connection on the published port
			// whether or not anything listens inside, and holds it open.
			hostPortProbe: false,
			composeProjectResources: false,
			assignedHostPorts: false,
		},

		availability() {
			return appleContainerAvailability(cli);
		},

		ensureRunning(ensureOptions: EnsureRuntimeOptions = {}) {
			return ensureAppleContainerRunning(cli, ensureOptions);
		},

		// No `system status` first: the listing fails when the system is down,
		// which answers the same question one process sooner.
		containers(signal) {
			if (!isAppleContainerSupported())
				return Promise.reject(
					new Error("Apple container is not supported on this machine"),
				);
			return appleContainers(cli, signal);
		},

		logs(request) {
			return appleContainerLogs(cli, request);
		},

		up(request) {
			return appleUp(cli, request);
		},

		down(request) {
			return appleDown(cli, request);
		},

		stop(ids) {
			return appleStopByIds(cli, ids);
		},

		async exec(request) {
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

		async execArgv(request) {
			// Apple names the container itself, so the lookup only confirms it
			// runs; otherwise the caller would print Apple's own "not found".
			if (
				!(await isAppleServiceRunning(
					cli,
					request.projectName,
					request.serviceName,
					request.signal,
				))
			)
				return undefined;
			return [
				options.binary ?? APPLE_CONTAINER_COMMAND,
				"exec",
				"-i",
				...(request.tty ? ["-t"] : []),
				containerNameFor(request.projectName, request.serviceName),
				...request.command,
			];
		},

		// A machine that cannot run Apple container holds none of its volumes;
		// a listing that fails throws, as `containers` does.
		listVolumes() {
			if (!isAppleContainerSupported()) return Promise.resolve([]);
			return listAppleVolumes(cli);
		},

		// `container volume list` reports no size.
		volumeSizes() {
			return Promise.resolve(new Map());
		},

		removeVolumes(names) {
			return removeAppleVolumes(cli, names);
		},

		listComposeProjectResources() {
			return Promise.reject(new Error(NO_COMPOSE_PROJECTS));
		},

		removeComposeProjectResource() {
			return Promise.reject(new Error(NO_COMPOSE_PROJECTS));
		},
	};
}
