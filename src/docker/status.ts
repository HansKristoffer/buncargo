import {
	isContainerServing,
	parseContainerState,
} from "../container-runtime/container-state";
import type { ServiceRuntimeState } from "../container-runtime/types";
import { runDockerAsync } from "./binary";
import { dockerDaemonState, dockerUnavailableError } from "./preflight";

/**
 * Ensure Docker is running before attempting compose operations, or throw
 * naming the runtime behind `docker` and what to do about it.
 */
export function assertDockerRunning(binary?: string): void {
	const daemon = dockerDaemonState(binary);
	if (daemon.state !== "up") throw dockerUnavailableError(daemon, binary);
}

const SERVICE_STATE_FORMAT =
	'{{.Label "buncargo.service"}}\t{{.State}}\t{{.Status}}\t{{.Label "buncargo.service-hash"}}';

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

/**
 * The exit code Docker's human-readable status carries for a container that
 * stopped or is between restarts: `Exited (137) 3 minutes ago`,
 * `Restarting (1) 2 seconds ago`. Negative when Docker could not collect one
 * (`Exited (-1)`).
 */
export function parseDockerExitCode(status: string): number | undefined {
	const code = /^(?:exited|restarting) \((-?\d+)\)/i.exec(status.trim())?.[1];
	return code === undefined ? undefined : Number(code);
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
		const [service, state, status, serviceHash] = line.split("\t");
		if (!service) continue;
		const healthy = parseDockerHealth(status ?? "");
		const exitCode = parseDockerExitCode(status ?? "");
		const containerState = parseContainerState(state ?? "");
		states.push({
			service,
			state: containerState,
			running: isContainerServing(containerState),
			...(serviceHash ? { serviceHash } : {}),
			...(healthy === undefined ? {} : { healthy }),
			...(exitCode === undefined ? {} : { exitCode }),
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
	// A daemon that cannot answer throws: an empty project is something the
	// service watch reports, and "could not ask" must not read as one.
	if (!result.ok)
		throw new Error(
			result.stderr.trim() || `docker ps exited ${result.exitCode}`,
		);
	return parseDockerServiceStates(result.stdout);
}
