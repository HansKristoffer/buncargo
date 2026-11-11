import { serviceStatesOf } from "../container-runtime/containers";
import type { ServiceRuntimeState } from "../container-runtime/types";
import { listDockerContainersAsync } from "./containers";
import { dockerDaemonState, dockerUnavailableError } from "./preflight";

/**
 * Ensure Docker is running before attempting compose operations, or throw
 * naming the runtime behind `docker` and what to do about it.
 */
export function assertDockerRunning(binary?: string): void {
	const daemon = dockerDaemonState(binary);
	if (daemon.state !== "up") throw dockerUnavailableError(daemon, binary);
}

/**
 * Every container this project has, in one `docker ps`. Throws when Docker
 * cannot answer: an empty project is something the service watch reports.
 */
export async function dockerProjectServiceStates(
	project: string,
	binary?: string,
	signal?: AbortSignal,
): Promise<ServiceRuntimeState[]> {
	return serviceStatesOf(
		await listDockerContainersAsync(binary, { signal }),
		project,
	);
}
