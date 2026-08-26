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
