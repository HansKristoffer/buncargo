import { execSync } from "node:child_process";
import { DockerUnavailableError, isDockerDaemonRunning } from "./preflight";

export const DOCKER_NOT_RUNNING_MESSAGE =
	"Docker is not running. Please start Docker and try again.";

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
	return isDockerDaemonRunning();
}

/**
 * Ensure Docker is running before attempting compose operations.
 */
export function assertDockerRunning(): void {
	if (!isDockerDaemonRunning()) {
		throw new DockerUnavailableError("unknown", DOCKER_NOT_RUNNING_MESSAGE);
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
