import { execSync } from "node:child_process";
import { sleep } from "../core/utils";
import type {
	BuiltInHealthCheck,
	HealthCheckFn,
	ServiceConfig,
} from "../types";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

export const POLL_INTERVAL = 250; // Fast polling for quicker startup
export const MAX_ATTEMPTS = 120; // 30 seconds total (120 * 250ms)
export const DOCKER_NOT_RUNNING_MESSAGE =
	"Docker is not running. Please start Docker and try again.";

// ═══════════════════════════════════════════════════════════════════════════
// Container Status Checks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a specific container service is running using docker ps.
 */
export async function isContainerRunning(
	project: string,
	service: string,
): Promise<boolean> {
	try {
		const result = execSync(
			`docker ps --filter "label=com.docker.compose.project=${project}" --filter "label=com.docker.compose.service=${service}" --format "{{.State}}"`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		return result.trim() === "running";
	} catch {
		return false;
	}
}

/**
 * Check if Docker daemon is running and reachable.
 */
export function isDockerRunning(): boolean {
	try {
		execSync('docker info --format "{{.ServerVersion}}"', {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure Docker is running before attempting compose operations.
 */
export function assertDockerRunning(): void {
	if (!isDockerRunning()) {
		throw new Error(DOCKER_NOT_RUNNING_MESSAGE);
	}
}

/**
 * Check if all expected containers are running.
 */
export async function areContainersRunning(
	project: string,
	minCount = 1,
): Promise<boolean> {
	try {
		const result = execSync(
			`docker ps --filter "label=com.docker.compose.project=${project}" --format "{{.State}}"`,
			{ encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
		);
		const states = result.trim().split("\n").filter(Boolean);
		if (states.length < minCount) return false;
		return states.every((state) => state === "running");
	} catch {
		return false;
	}
}

/**
 * Check if the requested compose services are all running.
 */
export async function areServicesRunning(
	project: string,
	serviceNames: string[],
): Promise<boolean> {
	if (serviceNames.length === 0) return false;
	const runningStates = await Promise.all(
		serviceNames.map((serviceName) => isContainerRunning(project, serviceName)),
	);
	return runningStates.every(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// Container Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

export interface StartContainersOptions {
	verbose?: boolean;
	wait?: boolean;
	composeFile?: string;
	services?: string[];
}

export interface ComposeCommandContext {
	projectName?: string;
	composeFile?: string;
}

/**
 * Build `-f` argument for docker compose.
 */
export function getComposeArg(composeFile?: string): string {
	return composeFile ? `-f "${composeFile}"` : "";
}

/**
 * Build `docker compose` prefix with optional project and compose file args.
 */
export function getComposeCommandPrefix(
	context: ComposeCommandContext = {},
): string {
	const { projectName, composeFile } = context;
	const composeArg = getComposeArg(composeFile);
	const projectArg = projectName ? `-p ${projectName}` : "";
	return `docker compose ${composeArg} ${projectArg}`.trim();
}

/**
 * Start Docker Compose containers.
 */
export function startContainers(
	root: string,
	projectName: string,
	envVars: Record<string, string>,
	options: StartContainersOptions = {},
): void {
	const { verbose = true, wait = true, composeFile, services = [] } = options;
	assertDockerRunning();

	if (verbose) console.log("🐳 Starting Docker containers...");

	const composeArg = getComposeArg(composeFile);
	const waitFlag = wait ? "--wait" : "";
	const servicesArg = services.join(" ");
	const cmd =
		`docker compose ${composeArg} up -d ${waitFlag} ${servicesArg}`.trim();

	execSync(cmd, {
		cwd: root,
		env: { ...process.env, ...envVars, COMPOSE_PROJECT_NAME: projectName },
		stdio: verbose ? "inherit" : "ignore",
	});

	if (verbose) console.log("✓ Containers started");
}

export interface StopContainersOptions {
	verbose?: boolean;
	removeVolumes?: boolean;
	composeFile?: string;
}

/**
 * Stop Docker Compose containers.
 */
export function stopContainers(
	root: string,
	projectName: string,
	options: StopContainersOptions = {},
): void {
	const { verbose = true, removeVolumes = false, composeFile } = options;
	assertDockerRunning();

	if (verbose) {
		console.log(
			removeVolumes
				? "🗑️  Stopping containers and removing volumes..."
				: "🛑 Stopping containers...",
		);
	}

	const composeArg = getComposeArg(composeFile);
	const volumeFlag = removeVolumes ? "-v" : "";
	const cmd = `docker compose ${composeArg} down ${volumeFlag}`.trim();

	execSync(cmd, {
		cwd: root,
		env: { ...process.env, COMPOSE_PROJECT_NAME: projectName },
		stdio: verbose ? "inherit" : "ignore",
	});

	if (verbose) console.log("✓ Containers stopped");
}

/**
 * Start a specific service only.
 */
export function startService(
	root: string,
	projectName: string,
	serviceName: string,
	envVars: Record<string, string>,
	options: { verbose?: boolean; composeFile?: string } = {},
): void {
	const { verbose = true, composeFile } = options;
	assertDockerRunning();

	if (verbose) console.log(`🐳 Starting ${serviceName}...`);

	const composeArg = getComposeArg(composeFile);
	const cmd = `docker compose ${composeArg} up -d ${serviceName}`.trim();

	execSync(cmd, {
		cwd: root,
		env: { ...process.env, ...envVars, COMPOSE_PROJECT_NAME: projectName },
		stdio: verbose ? "inherit" : "ignore",
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// Built-in Health Checks
// ═══════════════════════════════════════════════════════════════════════════

export interface HealthCheckContext {
	projectName?: string;
	root?: string;
	composeFile?: string;
}

/**
 * Create a health check function from a built-in type.
 */
export function createBuiltInHealthCheck(
	type: BuiltInHealthCheck,
	serviceName: string,
	context: HealthCheckContext = {},
): HealthCheckFn {
	const { projectName, root, composeFile } = context;
	const composeCommandPrefix = getComposeCommandPrefix({
		projectName,
		composeFile,
	});

	switch (type) {
		case "pg_isready":
			return async () => {
				try {
					execSync(
						`${composeCommandPrefix} exec -T ${serviceName} pg_isready -U postgres`,
						{
							cwd: root,
							stdio: ["pipe", "pipe", "pipe"],
						},
					);
					return true;
				} catch {
					return false;
				}
			};

		case "redis-cli":
			return async () => {
				try {
					execSync(
						`${composeCommandPrefix} exec -T ${serviceName} redis-cli ping`,
						{
							cwd: root,
							stdio: ["pipe", "pipe", "pipe"],
						},
					);
					return true;
				} catch {
					return false;
				}
			};

		case "http":
			return async (port) => {
				try {
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 2000);
					try {
						const response = await fetch(`http://localhost:${port}/`, {
							signal: controller.signal as RequestInit["signal"],
						});
						clearTimeout(timeoutId);
						return response.ok || response.status === 404;
					} catch {
						clearTimeout(timeoutId);
						return false;
					}
				} catch {
					return false;
				}
			};

		case "tcp":
			return async (port) => {
				// TCP check using a quick fetch that will fail fast if port is closed
				try {
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 1000);
					try {
						await fetch(`http://localhost:${port}/`, {
							signal: controller.signal as RequestInit["signal"],
						});
						clearTimeout(timeoutId);
						return true;
					} catch (error) {
						clearTimeout(timeoutId);
						// Connection refused means port is not open
						// Other errors (like timeout) might mean it's open but not HTTP
						if (
							error instanceof Error &&
							error.message.includes("ECONNREFUSED")
						) {
							return false;
						}
						return true; // Assume open for other errors
					}
				} catch {
					return false;
				}
			};

		default:
			return async () => true;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Readiness
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Wait for a service to be healthy.
 */
export async function waitForService(
	serviceName: string,
	config: ServiceConfig,
	port: number,
	options: {
		maxAttempts?: number;
		pollInterval?: number;
		projectName?: string;
		root?: string;
		composeFile?: string;
	} = {},
): Promise<void> {
	const {
		maxAttempts = MAX_ATTEMPTS,
		pollInterval = POLL_INTERVAL,
		projectName,
		root,
		composeFile,
	} = options;

	// No health check configured - just return
	if (config.healthCheck === false || config.healthCheck === undefined) {
		return;
	}

	// Get or create health check function
	const healthCheckFn =
		typeof config.healthCheck === "function"
			? config.healthCheck
			: createBuiltInHealthCheck(
					config.healthCheck,
					config.serviceName ?? serviceName,
					{ projectName, root, composeFile },
				);

	for (let i = 0; i < maxAttempts; i++) {
		const isHealthy = await healthCheckFn(port);
		if (isHealthy) return;
		await sleep(pollInterval);
	}

	throw new Error(`Service ${serviceName} did not become ready in time`);
}

/**
 * Wait for all services to be healthy.
 */
export async function waitForAllServices(
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	options: {
		maxAttempts?: number;
		pollInterval?: number;
		verbose?: boolean;
		projectName?: string;
		root?: string;
		composeFile?: string;
	} = {},
): Promise<void> {
	const { verbose = true, ...waitOptions } = options;

	if (verbose) console.log("⏳ Waiting for services to be healthy...");

	const promises = Object.entries(services).map(([name, config]) => {
		const port = ports[name];
		if (port === undefined) {
			console.warn(
				`⚠️  No port found for service ${name}, skipping health check`,
			);
			return Promise.resolve();
		}
		return waitForService(name, config, port, waitOptions);
	});

	await Promise.all(promises);

	if (verbose) console.log("✓ All services healthy");
}

/**
 * Wait for a service to be healthy using a built-in health check type.
 * Simpler API when you don't have a ServiceConfig object.
 */
export async function waitForServiceByType(
	serviceName: string,
	healthCheckType: BuiltInHealthCheck,
	port: number,
	options: {
		maxAttempts?: number;
		pollInterval?: number;
		verbose?: boolean;
		projectName?: string;
		root?: string;
		composeFile?: string;
	} = {},
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

	for (let i = 0; i < maxAttempts; i++) {
		const isHealthy = await healthCheckFn(port);
		if (isHealthy) {
			if (verbose) console.log(`✓ ${serviceName} is ready`);
			return;
		}
		await sleep(pollInterval);
	}

	throw new Error(`Service ${serviceName} did not become ready in time`);
}

export interface EnsureServicesRunningOptions {
	verbose?: boolean;
	wait?: boolean;
	composeFile?: string;
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
	const { verbose = true, wait = true, composeFile } = options;
	const composeServiceNames = Object.entries(services).map(
		([serviceKey, config]) => config.serviceName ?? serviceKey,
	);
	const alreadyRunning = await areServicesRunning(
		projectName,
		composeServiceNames,
	);

	if (alreadyRunning) {
		if (verbose) console.log("✓ Containers already running");
	} else {
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

	return {
		started: !alreadyRunning,
		composeServiceNames,
	};
}
