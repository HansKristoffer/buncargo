import {
	abortableSleep,
	DeadlineExceededError,
	remainingTime,
	withDeadline,
} from "../core/deadline";
import {
	classifyPortOccupant,
	createPortOwnerSnapshot,
	formatPortOwner,
} from "../core/process";
import { recordStartupMetric } from "../core/startup-metrics";
import {
	formatDone,
	formatWait,
	formatWarn,
	SLOW_STEP_MS,
	scheduleLog,
} from "../core/style";
import type { ComposeDocument } from "../docker-compose";
import {
	canProveServiceInputs,
	projectStackHash,
	STACK_HASH_ENV,
	serviceFingerprint,
	serviceHashEnv,
} from "../docker-compose/interpolate";
import type { BuiltInHealthCheck, ServiceConfig } from "../types";
import { createBuiltInHealthCheck } from "./health-checks";
import { availableContainerRuntimes } from "./resolve";
import type {
	ContainerRuntimeAdapter,
	ServiceDiagnosis,
	ServiceRuntimeState,
} from "./types";
import { isTerminalContainerState } from "./types";

export const POLL_INTERVAL = 250; // Fast polling for quicker startup
export const MAX_ATTEMPTS = 120; // 30 seconds total (120 * 250ms)

export interface WaitForServiceOptions {
	signal?: AbortSignal;
	runtime: ContainerRuntimeAdapter;
	projectName: string;
	maxAttempts?: number;
	pollInterval?: number;
	root?: string;
	composeFile?: string;
}

/**
 * How often, in poll attempts, to ask the runtime whether the container is
 * still alive. Every attempt would mean a CLI call four times a second for a
 * question that only changes once.
 */
const DIAGNOSIS_EVERY_ATTEMPTS = 8;

interface HealthPollContext {
	/** The key the user wrote in dev.config. */
	serviceName: string;
	/** What the runtime knows the container as. */
	composeServiceName: string;
	runtime: ContainerRuntimeAdapter;
	projectName: string;
	probe: string;
	port: number;
	root?: string;
	composeFile?: string;
}

/** Never throws: a diagnosis that fails must not break the poll it decorates. */
async function diagnose(
	context: HealthPollContext,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ServiceDiagnosis | undefined> {
	try {
		const request = {
			signal,
			timeoutMs,
			projectName: context.projectName,
			serviceName: context.composeServiceName,
			root: context.root,
			composeFile: context.composeFile,
		};
		const diagnoseAsync = context.runtime.diagnoseServiceAsync;
		return diagnoseAsync
			? await withDeadline(
					(probeSignal) =>
						diagnoseAsync.call(context.runtime, {
							...request,
							signal: probeSignal,
						}),
					timeoutMs,
					signal,
				)
			: context.runtime.diagnoseService(request);
	} catch {
		return undefined;
	}
}

function withLogTail(message: string, diagnosis?: ServiceDiagnosis): string {
	const tail = diagnosis?.logTail?.trim();
	if (!tail) return message;
	const indented = tail
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
	return `${message}\n  Last output from the container:\n${indented}`;
}

async function pollUntilHealthy(
	context: HealthPollContext,
	check: (port: number, signal?: AbortSignal) => Promise<boolean>,
	timeoutMs: number,
	pollInterval: number,
	onReady?: () => void,
	signal?: AbortSignal,
): Promise<void> {
	const { serviceName, runtime, probe, port } = context;
	let lastDiagnosis: ServiceDiagnosis | undefined;

	const deadline = performance.now() + timeoutMs;
	for (let i = 0; remainingTime(deadline) > 0; i++) {
		if (i > 0) recordStartupMetric("healthRetries");
		signal?.throwIfAborted();
		let healthy = false;
		try {
			healthy = await withDeadline(
				(probeSignal) => check(port, probeSignal),
				remainingTime(deadline),
				signal,
			);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof DeadlineExceededError) break;
			if (remainingTime(deadline) > 0) throw error;
		}
		if (healthy) {
			onReady?.();
			return;
		}

		if (i > 0 && i % DIAGNOSIS_EVERY_ATTEMPTS === 0) {
			lastDiagnosis = await diagnose(context, remainingTime(deadline), signal);
			if (lastDiagnosis && isTerminalContainerState(lastDiagnosis.state)) {
				const exit =
					lastDiagnosis.exitCode !== undefined
						? ` (exit code ${lastDiagnosis.exitCode})`
						: "";
				throw new Error(
					withLogTail(
						`Service ${serviceName} stopped while starting up: ${runtime.displayName} reports state "${lastDiagnosis.state}"${exit}.`,
						lastDiagnosis,
					),
				);
			}
		}

		await abortableSleep(
			Math.min(pollInterval, remainingTime(deadline)),
			signal,
		);
	}

	signal?.throwIfAborted();
	if (!runtime.diagnoseServiceAsync)
		lastDiagnosis = (await diagnose(context, 0, signal)) ?? lastDiagnosis;
	const seconds = timeoutMs / 1000;
	const state = lastDiagnosis
		? ` Container state: ${lastDiagnosis.state}.`
		: " No container was found for it.";
	throw new Error(
		withLogTail(
			`Service ${serviceName} did not become ready within ${seconds}s (${runtime.displayName}, ${probe} probe on port ${port}).${state}`,
			lastDiagnosis,
		),
	);
}

/**
 * Wait for a service to be healthy.
 */
export async function waitForService(
	serviceName: string,
	config: ServiceConfig,
	port: number,
	options: WaitForServiceOptions,
): Promise<void> {
	const pollInterval = options.pollInterval ?? POLL_INTERVAL;
	const { runtime, projectName, root, composeFile } = options;
	const timeoutMs =
		config.healthTimeout ??
		(options.maxAttempts !== undefined
			? options.maxAttempts * pollInterval
			: 30_000);

	if (config.healthCheck === false || config.healthCheck === undefined) {
		return;
	}

	const composeServiceName = config.serviceName ?? serviceName;
	const healthCheckFn =
		typeof config.healthCheck === "function"
			? config.healthCheck
			: createBuiltInHealthCheck(config.healthCheck, composeServiceName, {
					runtime,
					projectName,
					root,
					composeFile,
				});

	await pollUntilHealthy(
		{
			serviceName,
			composeServiceName,
			runtime,
			projectName,
			probe:
				typeof config.healthCheck === "function"
					? "custom"
					: config.healthCheck,
			port,
			root,
			composeFile,
		},
		healthCheckFn,
		timeoutMs,
		pollInterval,
		undefined,
		options.signal,
	);
}

/**
 * Wait for all services to be healthy.
 */
/**
 * Built-in probes that run *inside* the container, through the runtime's CLI.
 *
 * These spawn runtime CLI processes, and they are also the probes the
 * generated compose healthcheck already runs, so a runtime reporting the
 * container healthy has just answered the same question. The host-side probes
 * (`http`, `tcp`) need no subprocess and
 * additionally prove the port is published, so they always run.
 */
const IN_CONTAINER_PROBES = new Set(["pg_isready", "redis-cli"]);

/**
 * Whether the runtime has already answered this service's readiness.
 *
 * Only a positive report counts: `undefined` means the runtime runs no
 * healthcheck for it, which is not the same as unhealthy.
 */
export function runtimeAnsweredReadiness(
	config: ServiceConfig,
	healthy: boolean | undefined,
): boolean {
	if (healthy !== true) return false;
	const docker =
		config.docker?.kind === "preset" ? config.docker.service : config.docker;
	// A caller can replace Compose's probe with a different health criterion.
	if (docker?.healthcheck !== undefined) return false;
	return (
		typeof config.healthCheck === "string" &&
		IN_CONTAINER_PROBES.has(config.healthCheck)
	);
}

export async function waitForAllServices(
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	options: WaitForServiceOptions & {
		verbose?: boolean;
		/** Compose service names the runtime already reports healthy. */
		healthyServices?: Set<string>;
	},
): Promise<void> {
	const { verbose = true, healthyServices, ...waitOptions } = options;
	const controller = new AbortController();
	const cancel = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) cancel();
	else options.signal?.addEventListener("abort", cancel, { once: true });
	waitOptions.signal = controller.signal;

	let showedWait = false;
	const cancelWait = verbose
		? scheduleLog(SLOW_STEP_MS, () => {
				showedWait = true;
				console.log(formatWait("Waiting for services to be healthy..."));
			})
		: () => {};

	try {
		await Promise.all(
			Object.entries(services).map(([name, config]) => {
				const port = ports[name];
				if (port === undefined) {
					console.warn(
						formatWarn(
							`No port found for service ${name}, skipping health check`,
						),
					);
					return Promise.resolve();
				}
				if (
					healthyServices?.has(config.serviceName ?? name) &&
					runtimeAnsweredReadiness(config, true)
				) {
					return Promise.resolve();
				}
				return waitForService(name, config, port, waitOptions);
			}),
		);
	} finally {
		controller.abort();
		options.signal?.removeEventListener("abort", cancel);
		cancelWait();
	}

	if (showedWait) console.log(formatDone("All services healthy"));
}

/**
 * Wait for a service to be healthy using a built-in health check type.
 * Simpler API when you don't have a ServiceConfig object.
 */
export async function waitForServiceByType(
	serviceName: string,
	healthCheckType: BuiltInHealthCheck,
	port: number,
	options: WaitForServiceOptions & { verbose?: boolean },
): Promise<void> {
	const {
		maxAttempts = MAX_ATTEMPTS,
		pollInterval = POLL_INTERVAL,
		verbose = false,
		runtime,
		projectName,
		root,
		composeFile,
	} = options;
	const healthCheckFn = createBuiltInHealthCheck(healthCheckType, serviceName, {
		runtime,
		projectName,
		root,
		composeFile,
	});

	await pollUntilHealthy(
		{
			serviceName,
			composeServiceName: serviceName,
			runtime,
			projectName,
			probe: healthCheckType,
			port,
			root,
			composeFile,
		},
		healthCheckFn,
		maxAttempts * pollInterval,
		pollInterval,
		() => {
			if (verbose) console.log(formatDone(`${serviceName} is ready`));
		},
		options.signal,
	);
}

/** Never throws: a runtime that cannot answer reads as "reconcile". */
async function readProjectServiceStates(
	runtime: ContainerRuntimeAdapter,
	projectName: string,
	signal?: AbortSignal,
): Promise<ServiceRuntimeState[]> {
	try {
		return runtime.projectServiceStatesAsync
			? await runtime.projectServiceStatesAsync(projectName, signal)
			: runtime.projectServiceStates(projectName);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

function servicesAllRunning(
	states: ServiceRuntimeState[],
	serviceNames: string[],
): boolean {
	if (serviceNames.length === 0) return false;
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
	if (serviceNames.length === 0) return false;
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
 * Fail early when a foreign process or container already holds a service port.
 */
function assertServicePortsClaimable(
	runtime: ContainerRuntimeAdapter,
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	context: { root: string; projectName: string },
): void {
	const targetPorts = Object.keys(services)
		.flatMap((serviceKey) => [
			ports[serviceKey],
			ports[`${serviceKey}Secondary`],
		])
		.filter((port): port is number => port !== undefined);
	if (targetPorts.length === 0) return;

	const snapshot = createPortOwnerSnapshot({ runtime, ports: targetPorts });
	let diagnosticSnapshot:
		| ReturnType<typeof createPortOwnerSnapshot>
		| undefined;

	for (const port of targetPorts) {
		const owner = snapshot.owner(port);
		const classification = classifyPortOccupant(owner, {
			...context,
			runtime: runtime.name,
		});
		if (classification === "fail" && owner) {
			diagnosticSnapshot ??= createPortOwnerSnapshot({
				runtime,
				ports: targetPorts,
				fallbackRuntimes: availableContainerRuntimes().filter(
					(candidate) => candidate.name !== runtime.name,
				),
			});
			throw new Error(
				formatPortOwner(port, diagnosticSnapshot.owner(port) ?? owner, {
					runtime: runtime.name,
				}),
			);
		}
	}
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
	await runtime.ensureRunning({
		autoStart: autoStartRuntime,
		verbose,
		signal: request.signal,
	});

	assertServicePortsClaimable(runtime, services, ports, { root, projectName });

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

	const stackHash = projectStackHash({
		model,
		envVars: effectiveEnv,
		serviceNames: composeServiceNames,
	});
	const runtimeEnv = {
		...effectiveEnv,
		[STACK_HASH_ENV]: stackHash,
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
		if (runtime.upAsync) await runtime.upAsync(upRequest);
		else runtime.up(upRequest);
	}

	if (wait) {
		// Re-read only when the reconcile ran: `up` is what changes state, and
		// the states from before it describe the previous containers.
		const readyStates = upToDate
			? states
			: await readProjectServiceStates(runtime, projectName, request.signal);
		await waitForAllServices(services, ports, {
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
		});
	}

	return { started: !alreadyRunning, composeServiceNames };
}
