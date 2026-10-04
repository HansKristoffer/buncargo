import {
	abortableSleep,
	DeadlineExceededError,
	remainingTime,
	withDeadline,
} from "../core/deadline";
import { recordStartupMetric } from "../core/startup-metrics";
import {
	formatDone,
	formatWait,
	SLOW_STEP_MS,
	scheduleLog,
} from "../core/style";
import type { BuiltInHealthCheck, ServiceConfig } from "../types";
import { createBuiltInHealthCheck } from "./health-checks";
import type { ContainerRuntimeAdapter, ServiceDiagnosis } from "./types";
import { isTerminalContainerState } from "./types";

export const POLL_INTERVAL = 250; // Fast polling for quicker startup
export const MAX_ATTEMPTS = 120; // 30 seconds total (120 * 250ms)

export interface WaitForServiceOptions {
	verbose?: boolean;
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
	port?: number;
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
		return await withDeadline(
			(probeSignal) =>
				context.runtime.diagnoseService({ ...request, signal: probeSignal }),
			timeoutMs,
			signal,
		);
	} catch {
		return undefined;
	}
}

function withLogTail(message: string, diagnosis?: ServiceDiagnosis): string {
	const tail = diagnosis?.logTail?.trim();
	if (!tail) {
		return message;
	}

	const indented = tail
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
	return `${message}\n  Last output from the container:\n${indented}`;
}

async function pollUntilHealthy(
	context: HealthPollContext,
	check: (signal?: AbortSignal) => Promise<boolean>,
	timeoutMs: number,
	pollInterval: number,
	onReady?: () => void,
	signal?: AbortSignal,
): Promise<void> {
	const { serviceName, runtime, probe, port } = context;
	let lastDiagnosis: ServiceDiagnosis | undefined;

	const deadline = performance.now() + timeoutMs;
	for (let i = 0; remainingTime(deadline) > 0; i++) {
		if (i > 0) {
			recordStartupMetric("healthRetries");
		}
		signal?.throwIfAborted();
		let healthy = false;
		try {
			healthy = await withDeadline(
				(probeSignal) => check(probeSignal),
				remainingTime(deadline),
				signal,
			);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof DeadlineExceededError) {
				break;
			}

			if (remainingTime(deadline) > 0) {
				throw error;
			}
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
	// One last look, on its own small budget: the state of a container that
	// died in the final seconds is the whole explanation.
	lastDiagnosis = (await diagnose(context, 2000, signal)) ?? lastDiagnosis;

	const seconds = timeoutMs / 1000;
	const state = lastDiagnosis
		? ` Container state: ${lastDiagnosis.state}.`
		: " No container was found for it.";
	throw new Error(
		withLogTail(
			`Service ${serviceName} did not become ready within ${seconds}s (${runtime.displayName}, ${probe} probe${port === undefined ? "" : ` on port ${port}`}).${state}`,
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
	port: number | undefined,
	options: WaitForServiceOptions,
): Promise<void> {
	const pollInterval = options.pollInterval ?? POLL_INTERVAL;
	const { runtime, projectName, root, composeFile } = options;
	const timeoutMs =
		config.healthTimeout ??
		(options.maxAttempts !== undefined
			? options.maxAttempts * pollInterval
			: 30_000);

	if (config.kind === "job" || port === undefined) {
		const context = {
			serviceName,
			composeServiceName: config.serviceName ?? serviceName,
			runtime,
			projectName,
			probe: config.kind === "job" ? "completion" : "process",
			root,
			composeFile,
		};
		await pollUntilHealthy(
			context,
			async (signal) => {
				const state = await diagnose(
					context,
					Math.min(timeoutMs, 2000),
					signal,
				);
				if (state && isTerminalContainerState(state.state)) {
					if (
						config.kind === "job" &&
						state.state.toLowerCase() === "exited" &&
						state.exitCode === 0
					) {
						if (options.verbose) {
							console.log(
								withLogTail(formatDone(`Job ${serviceName} completed`), state),
							);
						}

						return true;
					}
					throw new Error(
						withLogTail(
							`Service ${serviceName} stopped in state ${state.state} (exit code ${state.exitCode ?? "unknown"})`,
							state,
						),
					);
				}

				return (
					config.kind !== "job" && state?.state.toLowerCase() === "running"
				);
			},
			timeoutMs,
			pollInterval,
			undefined,
			options.signal,
		);
		return;
	}

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
		(signal) => healthCheckFn(port, signal),
		timeoutMs,
		pollInterval,
		undefined,
		options.signal,
	);
}

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
	if (healthy !== true) {
		return false;
	}

	const docker =
		config.docker?.kind === "preset" ? config.docker.service : config.docker;
	// A caller can replace Compose's probe with a different health criterion.
	if (docker?.healthcheck !== undefined) {
		return false;
	}

	return (
		typeof config.healthCheck === "string" &&
		IN_CONTAINER_PROBES.has(config.healthCheck)
	);
}

/** Wait concurrently, cancelling the remaining probes if any service fails. */
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
	if (options.signal?.aborted) {
		cancel();
	} else {
		options.signal?.addEventListener("abort", cancel, { once: true });
	}
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

				if (
					healthyServices?.has(config.serviceName ?? name) &&
					runtimeAnsweredReadiness(config, true)
				) {
					return Promise.resolve();
				}

				return waitForService(name, config, port, { ...waitOptions, verbose });
			}),
		);
	} finally {
		controller.abort();
		options.signal?.removeEventListener("abort", cancel);
		cancelWait();
	}

	if (showedWait) {
		console.log(formatDone("All services healthy"));
	}
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
		(signal) => healthCheckFn(port, signal),
		maxAttempts * pollInterval,
		pollInterval,
		() => {
			if (verbose) {
				console.log(formatDone(`${serviceName} is ready`));
			}
		},
		options.signal,
	);
}
