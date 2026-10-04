import { recordStartupMetric } from "../core/startup-metrics";
import type { ComposeDocument } from "../docker-compose";
import {
	canProveServiceInputs,
	serviceFingerprint,
	serviceHashEnv,
} from "../docker-compose/interpolate";
import type { ServiceConfig } from "../types";
import { assertServiceCapabilities } from "./capabilities";
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
		return await runtime.projectServiceStates(projectName, signal);
	} catch {
		signal?.throwIfAborted();
		return [];
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
	envVars: Record<string, string>;
	services: Record<string, ServiceConfig>;
	ports: Record<string, number>;
	model: ComposeDocument;
	composeFile?: string;
	verbose?: boolean;
	wait?: boolean;
	/** Override the runtime's auto-start. Default: the runtime's own policy. */
	autoStartRuntime?: boolean;
}

/**
 * Ensure the requested service subset is running and healthy.
 */
export async function ensureServicesRunning(
	request: EnsureServicesRunningRequest,
): Promise<{ started: boolean; composeServiceNames: string[] }> {
	const {
		runtime,
		root,
		projectName,
		envVars,
		services,
		ports,
		model,
		composeFile,
		verbose = true,
		wait = true,
		autoStartRuntime,
	} = request;

	request.signal?.throwIfAborted();
	if (Object.keys(services).length === 0) {
		return { started: false, composeServiceNames: [] };
	}

	assertServiceCapabilities(runtime.name, services);

	await runtime.ensureRunning({
		autoStart: autoStartRuntime,
		verbose,
		signal: request.signal,
	});

	await assertServicePortsClaimable(
		runtime,
		services,
		ports,
		{ root, projectName },
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
	const hashes = Object.fromEntries(
		Object.keys(model.services).map((name) => [
			name,
			serviceFingerprint(model, name, effectiveEnv),
		]),
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

	const states = await readProjectServiceStates(
		runtime,
		projectName,
		request.signal,
	);
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
			// Readiness is polled below against the published ports, which works
			// the same on both backends; a runtime-side wait would only be a
			// second, weaker copy of it.
			wait: false,
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
				composeFile,
				healthyServices: new Set(
					readyStates
						.filter((state) => state.running && state.healthy === true)
						.map((state) => state.service),
				),
			},
		);
	}

	return { started: !alreadyRunning, composeServiceNames };
}
