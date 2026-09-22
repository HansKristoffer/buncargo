import type { ServiceRuntimeState } from "../container-runtime/types";
import { runDockerAsync } from "./binary";
import { DockerUnavailableError, isDockerDaemonRunning } from "./preflight";

export const DOCKER_NOT_RUNNING_MESSAGE =
	"Docker is not running. Please start Docker and try again.";

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

const SERVICE_STATE_FORMAT =
	'{{.Label "buncargo.service"}}\t{{.State}}\t{{.Label "buncargo.stack-hash"}}\t{{.Status}}\t{{.Label "buncargo.service-hash"}}';

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
		const [service, state, stackHash, status, serviceHash] = line.split("\t");
		if (!service) continue;
		const healthy = parseDockerHealth(status ?? "");
		states.push({
			service,
			running: state === "running",
			...(stackHash ? { stackHash } : {}),
			...(serviceHash ? { serviceHash } : {}),
			...(healthy === undefined ? {} : { healthy }),
		});
	}
	return states;
}

/**
 * Every container this project has, in one `docker ps`.
 *
 * One listing rather than one per service: a four-service stack used to pay
 * four of them before anything started.
 */
export async function dockerProjectServiceStates(
	project: string,
	binary?: string,
	signal?: AbortSignal,
): Promise<ServiceRuntimeState[]> {
	const result = await runDockerAsync(
		binary,
		[
			"ps",
			"--all",
			"--filter",
			`label=buncargo.project=${project}`,
			"--format",
			SERVICE_STATE_FORMAT,
		],
		{ signal },
	);
	return result.ok ? parseDockerServiceStates(result.stdout) : [];
}
