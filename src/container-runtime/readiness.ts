import {
	classifyPortOccupant,
	formatPortOwner,
	getPortOwner,
} from "../core/process";
import {
	formatDone,
	formatWait,
	formatWarn,
	SLOW_STEP_MS,
	scheduleLog,
} from "../core/style";
import { sleep } from "../core/utils";
import type { ComposeDocument } from "../docker-compose";
import type { BuiltInHealthCheck, ServiceConfig } from "../types";
import { createBuiltInHealthCheck } from "./health-checks";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter, ServiceDiagnosis } from "./types";
import { isTerminalContainerState } from "./types";

export const POLL_INTERVAL = 250; // Fast polling for quicker startup
export const MAX_ATTEMPTS = 120; // 30 seconds total (120 * 250ms)

export interface WaitForServiceOptions {
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
function diagnose(context: HealthPollContext): ServiceDiagnosis | undefined {
	try {
		return context.runtime.diagnoseService({
			projectName: context.projectName,
			serviceName: context.composeServiceName,
			root: context.root,
			composeFile: context.composeFile,
		});
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
	check: (port: number) => Promise<boolean>,
	attempts: number,
	pollInterval: number,
	onReady?: () => void,
): Promise<void> {
	const { serviceName, runtime, probe, port } = context;
	let lastDiagnosis: ServiceDiagnosis | undefined;

	for (let i = 0; i < attempts; i++) {
		if (await check(port)) {
			onReady?.();
			return;
		}

		if (i > 0 && i % DIAGNOSIS_EVERY_ATTEMPTS === 0) {
			lastDiagnosis = diagnose(context);
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

		await sleep(pollInterval);
	}

	lastDiagnosis = diagnose(context) ?? lastDiagnosis;
	const seconds = Math.round((attempts * pollInterval) / 1000);
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
	const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollInterval));

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
		maxAttempts,
		pollInterval,
	);
}

/**
 * Wait for all services to be healthy.
 */
export async function waitForAllServices(
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	options: WaitForServiceOptions & { verbose?: boolean },
): Promise<void> {
	const { verbose = true, ...waitOptions } = options;

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
				return waitForService(name, config, port, waitOptions);
			}),
		);
	} finally {
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
		maxAttempts,
		pollInterval,
		() => {
			if (verbose) console.log(formatDone(`${serviceName} is ready`));
		},
	);
}

export interface EnsureServicesRunningRequest {
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
		.map((serviceKey) => ports[serviceKey])
		.filter((port): port is number => port !== undefined);
	if (targetPorts.length === 0) return;

	// Probed once for the whole check rather than per port: this is the one
	// place a container on the other backend is worth the extra CLI calls, and
	// the answer cannot change between two ports of the same run.
	const fallbackRuntimes = availableContainerRuntimes().filter(
		(candidate) => candidate.name !== runtime.name,
	);

	for (const port of targetPorts) {
		const owner = getPortOwner(port, { runtime, fallbackRuntimes });
		const classification = classifyPortOccupant(owner, {
			...context,
			runtime: runtime.name,
		});
		if (classification === "fail" && owner) {
			throw new Error(formatPortOwner(port, owner, { runtime: runtime.name }));
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

	await runtime.ensureRunning({ autoStart: autoStartRuntime, verbose });

	assertServicePortsClaimable(runtime, services, ports, { root, projectName });

	const composeServiceNames = Object.entries(services).map(
		([serviceKey, config]) => config.serviceName ?? serviceKey,
	);
	const alreadyRunning = await runtime.areServicesRunning(
		projectName,
		composeServiceNames,
	);

	// `up` runs even when the services are already up, because that is the only
	// place either backend compares the running container against the config it
	// was started from. Skipping it made an edited image, port or env var take
	// effect only after a manual `--down`. Both backends are idempotent here:
	// compose no-ops when nothing changed, and Apple's config-hash label turns
	// an unchanged service into a `start`.
	runtime.up({
		root,
		projectName,
		envVars,
		model,
		serviceNames: composeServiceNames,
		composeFile,
		verbose: verbose && !alreadyRunning,
		// Readiness is polled below against the published ports, which works
		// the same on both backends; a runtime-side wait would only be a
		// second, weaker copy of it.
		wait: false,
	});

	if (wait) {
		await waitForAllServices(services, ports, {
			runtime,
			projectName,
			verbose,
			root,
			composeFile,
		});
	}

	return { started: !alreadyRunning, composeServiceNames };
}
