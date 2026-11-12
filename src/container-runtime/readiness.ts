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
import type {
	BuiltInHealthCheck,
	HealthCheckFn,
	ResolvedService,
} from "../types";
import {
	type ContainerObservation,
	isContainerServing,
	parseContainerState,
	startupVerdict,
} from "./container-state";
import { diagnoseService, serviceContainerOf } from "./containers";
import { createBuiltInHealthCheck } from "./health-checks";
import type { ContainerRuntimeAdapter, ServiceDiagnosis } from "./types";

const POLL_INTERVAL = 250; // Fast polling for quicker startup

export interface WaitForServiceOptions {
	verbose?: boolean;
	signal?: AbortSignal;
	runtime: ContainerRuntimeAdapter;
	projectName: string;
	root?: string;
}

/**
 * How often, in poll attempts, a probed service's poll asks the runtime
 * whether the container is still alive. Every attempt would mean a listing
 * four times a second for a question that only changes once.
 */
const STATE_CHECK_EVERY_ATTEMPTS = 8;

/**
 * How one service proves it is ready, decided from its config alone.
 *
 * - `runtimeHealth`: the runtime already ran this probe and it passed.
 * - `completion`: a job, ready when its container exits 0.
 * - `process`: no port to probe, ready while its container runs.
 * - `none`: nothing configured to wait for.
 * - `probe` and `custom`: a built-in or the config's own check on the port.
 */
export type ReadinessPlan =
	| { kind: "runtimeHealth" }
	| { kind: "completion" }
	| { kind: "process" }
	| { kind: "none" }
	| { kind: "probe"; probe: BuiltInHealthCheck; port: number }
	| { kind: "custom"; check: HealthCheckFn; port: number };

export function readinessPlan(
	config: ResolvedService,
	port: number | undefined,
	runtimeHealthy?: boolean,
): ReadinessPlan {
	if (runtimeAnsweredReadiness(config, runtimeHealthy))
		return { kind: "runtimeHealth" };
	if (config.kind === "job") return { kind: "completion" };
	if (port === undefined) return { kind: "process" };
	const check = config.healthCheck;
	if (check === false) return { kind: "none" };
	return typeof check === "function"
		? { kind: "custom", check, port }
		: { kind: "probe", probe: check, port };
}

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
}

/** What a poll saw of the container; `logTail` only once it was fetched. */
type Observation = ContainerObservation & { logTail?: string };

/**
 * The container's state and recent output. Never throws: a diagnosis that
 * fails must not break the poll it decorates.
 */
async function diagnose(
	context: HealthPollContext,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ServiceDiagnosis | undefined> {
	return diagnoseService(context.runtime, {
		signal,
		timeoutMs,
		projectName: context.projectName,
		serviceName: context.composeServiceName,
		root: context.root,
	});
}

/**
 * The container's state from the runtime's listing, without its logs: what
 * every poll asks. Never throws.
 */
async function observe(
	context: HealthPollContext,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Observation | undefined> {
	try {
		const container = serviceContainerOf(
			await withDeadline(
				(probeSignal) => context.runtime.containers(probeSignal),
				timeoutMs,
				signal,
			),
			context.projectName,
			context.composeServiceName,
		);
		if (!container) return undefined;
		return {
			state: container.runtimeState,
			...(container.exitCode === undefined
				? {}
				: { exitCode: container.exitCode }),
		};
	} catch {
		return undefined;
	}
}

/** The observation with the container's output, fetched now if it was not. */
async function withLogs(
	context: HealthPollContext,
	observation: Observation,
	signal?: AbortSignal,
): Promise<Observation> {
	if (observation.logTail !== undefined) return observation;
	const diagnosis = await diagnose(context, 2000, signal);
	return diagnosis ?? observation;
}

function withLogTail(message: string, observation?: Observation): string {
	const tail = observation?.logTail?.trim();
	if (!tail) {
		return message;
	}

	const indented = tail
		.split("\n")
		.map((line) => `    ${line}`)
		.join("\n");
	return `${message}\n  Last output from the container:\n${indented}`;
}

/**
 * The one poll loop every plan runs.
 *
 * A plan that is decided by the container's state (`completion`, `process`)
 * reads the listing every tick; a probed one reads it every few ticks to
 * catch a container that died. Either way the logs are fetched once, when
 * the wait fails, rather than with every reading.
 */
async function pollUntilReady(
	context: HealthPollContext,
	options: {
		/** Read the container's state every tick rather than every few. */
		everyTick: boolean;
		check: (
			observation: Observation | undefined,
			signal?: AbortSignal,
		) => Promise<boolean>;
		timeoutMs: number;
		pollInterval: number;
		signal?: AbortSignal;
	},
): Promise<void> {
	const { serviceName, runtime, probe, port } = context;
	const { timeoutMs, pollInterval, signal } = options;
	let lastObservation: Observation | undefined;
	let restartsInARow = 0;

	const deadline = performance.now() + timeoutMs;
	for (let i = 0; remainingTime(deadline) > 0; i++) {
		if (i > 0) {
			recordStartupMetric("healthRetries");
		}
		signal?.throwIfAborted();

		const observed =
			options.everyTick || (i > 0 && i % STATE_CHECK_EVERY_ATTEMPTS === 0);
		let observation: Observation | undefined;
		if (observed) {
			observation = await observe(
				context,
				Math.min(2000, remainingTime(deadline)),
				signal,
			);
			lastObservation = observation ?? lastObservation;
			if (observation) {
				// In a row: a service that exits while its dependency comes up,
				// then runs, is a restart policy doing its job, not a crash loop.
				const restarting =
					parseContainerState(observation.state) === "restarting";
				restartsInARow = restarting ? restartsInARow + 1 : 0;
			}
		}

		let ready = false;
		try {
			ready = await withDeadline(
				(probeSignal) => options.check(observation, probeSignal),
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

		if (ready) return;

		// Not on the first look: a container that has not appeared yet is
		// still being created, and a probe that is not ready yet is normal.
		if (observation && (options.everyTick || i > 0)) {
			// Restarts are counted only on the slower cadence: two readings a
			// tick apart are usually the same restart.
			const verdict = startupVerdict(
				observation,
				options.everyTick ? 0 : restartsInARow,
			);
			if (verdict.kind !== "pending") {
				const failed = await withLogs(context, observation, signal);
				const exit =
					failed.exitCode !== undefined
						? ` (exit code ${failed.exitCode})`
						: "";
				const reported = `${runtime.displayName} reports state "${failed.state}"${exit}`;
				const problem =
					verdict.kind === "crash-loop"
						? `Service ${serviceName} keeps crashing while starting up: ${reported} again and again.`
						: options.everyTick
							? `Service ${serviceName} stopped in state ${failed.state} (exit code ${failed.exitCode ?? "unknown"})`
							: `Service ${serviceName} stopped while starting up: ${reported}.`;
				throw new Error(withLogTail(problem, failed));
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
	const final = (await diagnose(context, 2000, signal)) ?? lastObservation;

	const seconds = timeoutMs / 1000;
	const state = final
		? ` Container state: ${final.state}.`
		: " No container was found for it.";
	throw new Error(
		withLogTail(
			`Service ${serviceName} did not become ready within ${seconds}s (${runtime.displayName}, ${probe} probe${port === undefined ? "" : ` on port ${port}`}).${state}`,
			final,
		),
	);
}

/**
 * Wait for a service to be healthy.
 */
export async function waitForService(
	serviceName: string,
	config: ResolvedService,
	port: number | undefined,
	options: WaitForServiceOptions,
	/** The runtime's own healthcheck verdict, when it reported one. */
	runtimeHealthy?: boolean,
): Promise<void> {
	await pollServiceReadiness(
		serviceName,
		config,
		port,
		{ ...options, pollInterval: POLL_INTERVAL },
		runtimeHealthy,
	);
}

/** {@link waitForService}, polling every `pollInterval` ms. */
export async function pollServiceReadiness(
	serviceName: string,
	config: ResolvedService,
	port: number | undefined,
	options: WaitForServiceOptions & { pollInterval: number },
	runtimeHealthy?: boolean,
): Promise<void> {
	const plan = readinessPlan(config, port, runtimeHealthy);
	if (plan.kind === "none" || plan.kind === "runtimeHealth") return;

	const { runtime, projectName, root, pollInterval } = options;
	const timeoutMs = config.healthTimeout;
	const composeServiceName = config.serviceName;
	const context: HealthPollContext = {
		serviceName,
		composeServiceName,
		runtime,
		projectName,
		probe: plan.kind === "probe" ? plan.probe : plan.kind,
		port:
			plan.kind === "probe" || plan.kind === "custom" ? plan.port : undefined,
		root,
	};
	const poll = { timeoutMs, pollInterval, signal: options.signal };

	if (plan.kind === "completion" || plan.kind === "process") {
		await pollUntilReady(context, {
			...poll,
			everyTick: true,
			check: async (observation, signal) => {
				if (!observation) return false;
				const state = parseContainerState(observation.state);
				if (
					plan.kind === "completion" &&
					state === "stopped" &&
					observation.exitCode === 0
				) {
					if (options.verbose)
						console.log(
							withLogTail(
								formatDone(`Job ${serviceName} completed`),
								await withLogs(context, observation, signal),
							),
						);
					return true;
				}
				return plan.kind === "process" && isContainerServing(state);
			},
		});
		return;
	}

	const check =
		plan.kind === "custom"
			? plan.check
			: createBuiltInHealthCheck(plan.probe, composeServiceName, {
					runtime,
					projectName,
					root,
				});
	await pollUntilReady(context, {
		...poll,
		everyTick: false,
		check: (_observation, signal) => check(plan.port, signal),
	});
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
	config: ResolvedService,
	healthy: boolean | undefined,
): boolean {
	if (healthy !== true) {
		return false;
	}

	const docker =
		config.kind === "external"
			? undefined
			: config.docker.kind === "preset"
				? config.docker.override
				: config.docker.service;
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
	services: Record<string, ResolvedService>,
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
				return waitForService(
					name,
					config,
					ports[name],
					{ ...waitOptions, verbose },
					healthyServices?.has(config.serviceName),
				);
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
