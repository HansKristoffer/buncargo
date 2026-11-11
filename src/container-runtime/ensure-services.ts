import { recordFromKeys } from "hanzio";
import { recordStartupMetric } from "../core/startup-metrics";
import type { ComposeDocument } from "../docker-compose";
import {
	canProveServiceInputs,
	serviceFingerprint,
	serviceHashEnv,
} from "../docker-compose/interpolate";
import type { PortContainerOwner, ResolvedService } from "../types";
import { assertServiceCapabilities } from "./capabilities";
import {
	portOwnersOf,
	projectServiceStates,
	serviceStatesOf,
} from "./containers";
import { waitForAllServices } from "./readiness";
import { assertServicePortsClaimable } from "./service-ports";
import type { ContainerRuntimeAdapter, ServiceRuntimeState } from "./types";

/** Never throws: a runtime that cannot answer reads as "reconcile". */
async function readProjectServiceStates(
	runtime: ContainerRuntimeAdapter,
	projectName: string,
	signal?: AbortSignal,
): Promise<ServiceRuntimeState[]> {
	try {
		return await projectServiceStates(runtime, projectName, signal);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/** What one listing of the runtime says about this start. */
interface RuntimeReading {
	states: ServiceRuntimeState[];
	/** Undefined when the runtime could not list: the port check asks it again. */
	portOwners?: Map<number, PortContainerOwner>;
}

/**
 * The project's service states and the ports' container owners, from one
 * listing.
 *
 * A listing that answers proves the runtime is up, so only one that fails
 * asks the runtime to start, or to throw why it cannot. That keeps a warm
 * start at one runtime call inside the project lock, where it used to be a
 * daemon probe and two listings of the same containers.
 */
async function readRuntime(
	runtime: ContainerRuntimeAdapter,
	projectName: string,
	ensureRunning: () => Promise<void>,
	signal?: AbortSignal,
): Promise<RuntimeReading> {
	const list = async (): Promise<RuntimeReading> => {
		const containers = await runtime.containers(signal);
		return {
			states: serviceStatesOf(containers, projectName),
			portOwners: portOwnersOf(containers, runtime.name),
		};
	};
	try {
		return await list();
	} catch {
		signal?.throwIfAborted();
	}
	await ensureRunning();
	try {
		return await list();
	} catch {
		signal?.throwIfAborted();
		return { states: [] };
	}
}

function servicesAllRunning(
	states: ServiceRuntimeState[],
	serviceNames: string[],
): boolean {
	if (serviceNames.length === 0) {
		return false;
	}

	const running = new Set(
		states.filter((state) => state.running).map((state) => state.service),
	);
	return serviceNames.every((name) => running.has(name));
}

/**
 * Whether every selected service is running from exactly this stack.
 *
 * A container with no hash — created before the label existed — is not a
 * match: "cannot compare" has to mean reconcile, or an upgrade would leave a
 * project running yesterday's config forever.
 */
function stackMatches(
	states: ServiceRuntimeState[],
	serviceNames: string[],
	hashes: Record<string, string>,
	provable: Set<string>,
): boolean {
	if (serviceNames.length === 0) {
		return false;
	}

	const byService = new Map(states.map((state) => [state.service, state]));
	return serviceNames.every((name) => {
		const state = byService.get(name);
		return (
			state?.running === true &&
			provable.has(name) &&
			state.serviceHash === hashes[name]
		);
	});
}

export interface EnsureServicesRunningRequest {
	noDeps?: boolean;
	signal?: AbortSignal;
	runtime: ContainerRuntimeAdapter;
	root: string;
	projectName: string;
	/**
	 * The configured `projectPrefix`, so a port conflict with a stack this
	 * checkout left under an old name says so. Without it the conflict names
	 * the holder only.
	 */
	projectPrefix?: string;
	envVars: Record<string, string>;
	services: Record<string, ResolvedService>;
	ports: Record<string, number>;
	model: ComposeDocument;
	composeFile?: string;
	verbose?: boolean;
	wait?: boolean;
	/** Override the runtime's auto-start. Default: the runtime's own policy. */
	autoStartRuntime?: boolean;
	/** `docker.startCommand`; see {@link EnsureRuntimeOptions.startCommand}. */
	runtimeStartCommand?: string;
}

/**
 * Ensure the requested service subset is running and healthy.
 *
 * `started` is whether this call brought containers up, created, started or
 * recreated them, rather than finding every one running from this config.
 */
export async function ensureServicesRunning(
	request: EnsureServicesRunningRequest,
): Promise<{ started: boolean; composeServiceNames: string[] }> {
	const {
		runtime,
		root,
		projectName,
		projectPrefix,
		envVars,
		services,
		ports,
		model,
		composeFile,
		verbose = true,
		wait = true,
		autoStartRuntime,
		runtimeStartCommand,
	} = request;

	request.signal?.throwIfAborted();
	if (Object.keys(services).length === 0) {
		return { started: false, composeServiceNames: [] };
	}

	assertServiceCapabilities(runtime, services);

	const { states, portOwners } = await readRuntime(
		runtime,
		projectName,
		() =>
			runtime.ensureRunning({
				autoStart: autoStartRuntime,
				startCommand: runtimeStartCommand,
				verbose,
				signal: request.signal,
			}),
		request.signal,
	);
	await assertServicePortsClaimable(
		runtime,
		services,
		ports,
		{ root, projectName, projectPrefix, containerOwners: portOwners },
		request.signal,
	);

	const composeServiceNames = Object.entries(services).map(
		([serviceKey, config]) => config.serviceName ?? serviceKey,
	);

	// Per-service fingerprints use the same effective environment passed to
	// the backend, and remain stable when a later run selects another subset.
	const effectiveEnv: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		),
		...envVars,
		COMPOSE_PROJECT_NAME: projectName,
	};
	const hashes = recordFromKeys(Object.keys(model.services), (name) =>
		serviceFingerprint(model, name, effectiveEnv),
	);
	const provable = new Set(
		composeServiceNames.filter((name) =>
			canProveServiceInputs(model, name, effectiveEnv),
		),
	);

	const runtimeEnv = {
		...effectiveEnv,
		...Object.fromEntries(
			Object.entries(hashes).map(([name, hash]) => [
				serviceHashEnv(name),
				hash,
			]),
		),
	};

	const alreadyRunning = servicesAllRunning(states, composeServiceNames);
	const upToDate = stackMatches(states, composeServiceNames, hashes, provable);

	// `up` is the only place either backend compares a running container
	// against the config it was started from, so skipping it unconditionally
	// made an edited image, port or env var take effect only after a manual
	// `--down`. The service hashes make that comparison explicit and cheap: it
	// covers the interpolated definition of every selected service, so anything
	// that would change a container changes it, and only an exact match skips.
	//
	// Worth doing because `docker compose up` on an unchanged stack still costs
	// most of a second, on a command a developer or an agent runs constantly.
	// A container from before the label carries no hash, which reads as "cannot
	// compare" and reconciles.
	recordStartupMetric(upToDate ? "container reuse" : "container reconcile");
	if (!upToDate) {
		const upRequest = {
			noDeps: request.noDeps,
			signal: request.signal,
			root,
			projectName,
			envVars: runtimeEnv,
			model,
			serviceNames: composeServiceNames,
			composeFile,
			verbose: verbose && !alreadyRunning,
		};
		await runtime.up(upRequest);
	}

	if (
		wait ||
		Object.values(services).some((service) => service.kind === "job")
	) {
		// Re-read only when the reconcile ran: `up` is what changes state, and
		// the states from before it describe the previous containers.
		const readyStates = upToDate
			? states
			: await readProjectServiceStates(runtime, projectName, request.signal);
		await waitForAllServices(
			wait
				? services
				: Object.fromEntries(
						Object.entries(services).filter(
							([, service]) => service.kind === "job",
						),
					),
			ports,
			{
				signal: request.signal,
				runtime,
				projectName,
				verbose,
				root,
				healthyServices: new Set(
					readyStates
						.filter((state) => state.running && state.healthy === true)
						.map((state) => state.service),
				),
			},
		);
	}

	// Not `!alreadyRunning`: a config change recreates containers that were
	// all running, and that start is still one.
	return { started: !upToDate, composeServiceNames };
}
