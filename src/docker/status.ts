import { dockerDaemonState, dockerUnavailableError } from "./preflight";

/**
 * Ensure Docker is running before attempting compose operations, or throw
 * naming the runtime behind `docker` and what to do about it.
 */
export function assertDockerRunning(binary?: string): void {
	const daemon = dockerDaemonState(binary);
	if (daemon.state !== "up") throw dockerUnavailableError(daemon, binary);
}
