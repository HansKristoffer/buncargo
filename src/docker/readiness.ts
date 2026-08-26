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
import type { BuiltInHealthCheck, ServiceConfig } from "../types";
import { createBuiltInHealthCheck } from "./health-checks";
import { startContainers } from "./lifecycle";
import { ensureDockerRunning } from "./preflight";
import { areServicesRunning } from "./status";

export const POLL_INTERVAL = 250; // Fast polling for quicker startup
export const MAX_ATTEMPTS = 120; // 30 seconds total (120 * 250ms)

export interface WaitForServiceOptions {
	maxAttempts?: number;
	pollInterval?: number;
	projectName?: string;
	root?: string;
	composeFile?: string;
}

async function pollUntilHealthy(
	serviceName: string,
	check: (port: number) => Promise<boolean>,
	port: number,
	attempts: number,
	pollInterval: number,
	onReady?: () => void,
): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		if (await check(port)) {
			onReady?.();
			return;
		}
		await sleep(pollInterval);
	}
	throw new Error(`Service ${serviceName} did not become ready in time`);
}

/**
 * Wait for a service to be healthy.
 */
export async function waitForService(
	serviceName: string,
	config: ServiceConfig,
	port: number,
	options: WaitForServiceOptions = {},
): Promise<void> {
	const pollInterval = options.pollInterval ?? POLL_INTERVAL;
	const { projectName, root, composeFile } = options;
	const timeoutMs =
		config.healthTimeout ??
		(options.maxAttempts !== undefined
			? options.maxAttempts * pollInterval
			: 30_000);
	const maxAttempts = Math.max(1, Math.ceil(timeoutMs / pollInterval));

	if (config.healthCheck === false || config.healthCheck === undefined) {
		return;
	}

	const healthCheckFn =
		typeof config.healthCheck === "function"
			? config.healthCheck
			: createBuiltInHealthCheck(
					config.healthCheck,
					config.serviceName ?? serviceName,
					{ projectName, root, composeFile },
				);

	await pollUntilHealthy(
		serviceName,
		healthCheckFn,
		port,
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
	options: WaitForServiceOptions & { verbose?: boolean } = {},
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
	options: WaitForServiceOptions & { verbose?: boolean } = {},
): Promise<void> {
	const {
		maxAttempts = MAX_ATTEMPTS,
		pollInterval = POLL_INTERVAL,
		verbose = false,
		projectName,
		root,
		composeFile,
	} = options;
	const healthCheckFn = createBuiltInHealthCheck(healthCheckType, serviceName, {
		projectName,
		root,
		composeFile,
	});

	await pollUntilHealthy(
		serviceName,
		healthCheckFn,
		port,
		maxAttempts,
		pollInterval,
		() => {
			if (verbose) console.log(formatDone(`${serviceName} is ready`));
		},
	);
}

export interface EnsureServicesRunningOptions {
	verbose?: boolean;
	wait?: boolean;
	composeFile?: string;
	autoStartDocker?: boolean;
}

/**
 * Fail early when a foreign process or container already holds a service port.
 */
function assertServicePortsClaimable(
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	context: { root: string; projectName: string },
): void {
	for (const serviceKey of Object.keys(services)) {
		const port = ports[serviceKey];
		if (port === undefined) continue;
		const owner = getPortOwner(port);
		if (classifyPortOccupant(owner, context) === "fail" && owner) {
			throw new Error(formatPortOwner(port, owner));
		}
	}
}

/**
 * Ensure the requested service subset is running and healthy.
 */
export async function ensureServicesRunning(
	root: string,
	projectName: string,
	envVars: Record<string, string>,
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	options: EnsureServicesRunningOptions = {},
): Promise<{ started: boolean; composeServiceNames: string[] }> {
	const { verbose = true, wait = true, composeFile, autoStartDocker } = options;
	await ensureDockerRunning({ autoStart: autoStartDocker, verbose });

	assertServicePortsClaimable(services, ports, { root, projectName });

	const composeServiceNames = Object.entries(services).map(
		([serviceKey, config]) => config.serviceName ?? serviceKey,
	);
	const alreadyRunning = await areServicesRunning(
		projectName,
		composeServiceNames,
	);

	if (!alreadyRunning) {
		startContainers(root, projectName, envVars, {
			verbose,
			wait: false,
			composeFile,
			services: composeServiceNames,
		});
	}

	if (wait) {
		await waitForAllServices(services, ports, {
			verbose,
			projectName,
			root,
			composeFile,
		});
	}

	return { started: !alreadyRunning, composeServiceNames };
}
