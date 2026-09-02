import type { ServiceRuntimeState } from "../container-runtime/types";
import { runDocker } from "./binary";
import { DockerUnavailableError, isDockerDaemonRunning } from "./preflight";

export const DOCKER_NOT_RUNNING_MESSAGE =
	"Docker is not running. Please start Docker and try again.";

/**
 * Check if a specific container service is running using docker ps.
 */
export async function isContainerRunning(
	project: string,
	service: string,
	binary?: string,
): Promise<boolean> {
	const result = runDocker(binary, [
		"ps",
		"--filter",
		`label=com.docker.compose.project=${project}`,
		"--filter",
		`label=com.docker.compose.service=${service}`,
		"--format",
		"{{.State}}",
	]);
	return result.ok && result.stdout.trim() === "running";
}

/**
 * Check if Docker daemon is running and reachable.
 */
export function isDockerRunning(binary?: string): boolean {
	return isDockerDaemonRunning(binary);
}

/**
 * Ensure Docker is running before attempting compose operations.
 */
export function assertDockerRunning(binary?: string): void {
	if (!isDockerDaemonRunning(binary)) {
		throw new DockerUnavailableError("unknown", DOCKER_NOT_RUNNING_MESSAGE);
	}
}

/**
 * Check if all expected containers are running.
 */
export async function areContainersRunning(
	project: string,
	minCount = 1,
	binary?: string,
): Promise<boolean> {
	const result = runDocker(binary, [
		"ps",
		"--filter",
		`label=com.docker.compose.project=${project}`,
		"--format",
		"{{.State}}",
	]);
	if (!result.ok) return false;
	const states = result.stdout.trim().split("\n").filter(Boolean);
	if (states.length < minCount) return false;
	return states.every((state) => state === "running");
}

/**
 * Check if the requested compose services are all running.
 */
export async function areServicesRunning(
	project: string,
	serviceNames: string[],
	binary?: string,
): Promise<boolean> {
	if (serviceNames.length === 0) return false;
	const runningStates = await Promise.all(
		serviceNames.map((serviceName) =>
			isContainerRunning(project, serviceName, binary),
		),
	);
	return runningStates.every(Boolean);
}

const SERVICE_STATE_FORMAT =
	'{{.Label "buncargo.service"}}\t{{.State}}\t{{.Label "buncargo.stack-hash"}}\t{{.Status}}';

/**
 * Docker reports its healthcheck inside the human-readable status, as
 * `Up 3 minutes (healthy)`.
 *
 * Absent for a container with no healthcheck, which has to read as "cannot
 * tell" rather than "unhealthy": the caller uses this to skip a probe, and
 * skipping one on a false positive would advertise a service that is not up.
 */
export function parseDockerHealth(status: string): boolean | undefined {
	if (status.includes("(healthy)")) return true;
	if (status.includes("(unhealthy)")) return false;
	return undefined;
}

export function parseDockerServiceStates(
	stdout: string,
): ServiceRuntimeState[] {
	const states: ServiceRuntimeState[] = [];
	// Split before trimming: a container with no `buncargo.service` label emits
	// an empty leading field, and trimming the whole output would shift every
	// column of that line by one.
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (!line.trim()) continue;
		const [service, state, stackHash, status] = line.split("\t");
		if (!service) continue;
		const healthy = parseDockerHealth(status ?? "");
		states.push({
			service,
			running: state === "running",
			...(stackHash ? { stackHash } : {}),
			...(healthy === undefined ? {} : { healthy }),
		});
	}
	return states;
}

/**
 * Every container this project has, in one `docker ps`.
 *
 * Replaces a `docker ps` per service: `areServicesRunning` asked separately
 * about each one, so a four-service stack paid four listings before anything
 * started.
 */
export function dockerProjectServiceStates(
	project: string,
	binary?: string,
): ServiceRuntimeState[] {
	const result = runDocker(binary, [
		"ps",
		"--all",
		"--filter",
		`label=buncargo.project=${project}`,
		"--format",
		SERVICE_STATE_FORMAT,
	]);
	if (!result.ok) return [];
	return parseDockerServiceStates(result.stdout);
}
