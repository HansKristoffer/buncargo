import type { ExecInServiceRequest } from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import { DEFAULT_DOCKER_BINARY, runDockerAsync } from "./binary";

/** Match Compose exec's default replica, excluding one-off run containers. */
function serviceContainerArgs(request: ExecInServiceRequest): string[] {
	return [
		"ps",
		"--filter",
		`label=com.docker.compose.project=${request.projectName}`,
		"--filter",
		`label=com.docker.compose.service=${request.serviceName}`,
		"--filter",
		"label=com.docker.compose.oneoff=False",
		"--filter",
		"label=com.docker.compose.container-number=1",
		"--format",
		"{{.ID}}",
	];
}

function uniqueContainerId(stdout: string): string | undefined {
	const ids = stdout.trim().split(/\s+/).filter(Boolean);
	return ids.length === 1 ? ids[0] : undefined;
}

/** `docker exec -i[t] <id> …` for the service's running container. */
export async function dockerInteractiveExecArgv(
	request: Omit<ExecInServiceRequest, "timeoutMs"> & { tty: boolean },
	binary?: string,
): Promise<string[] | undefined> {
	const listed = await runDockerAsync(binary, serviceContainerArgs(request), {
		cwd: request.root,
		signal: request.signal,
		timeoutMs: 10_000,
	});
	const id = listed.ok ? uniqueContainerId(listed.stdout) : undefined;
	if (!id) return undefined;
	return [
		binary ?? DEFAULT_DOCKER_BINARY,
		"exec",
		"-i",
		...(request.tty ? ["-t"] : []),
		id,
		...request.command,
	];
}

/**
 * Probe the running container directly. Compose reparses the whole project on
 * every exec and can take longer than the probe's two-second budget even when
 * Postgres is ready. Resolve by labels, not a guessed name or a cached ID, so
 * custom names, aliases and container recreation still target the right one.
 */
export async function execInDockerService(
	request: ExecInServiceRequest,
	binary?: string,
): Promise<boolean> {
	request.signal?.throwIfAborted();
	const deadline = performance.now() + (request.timeoutMs ?? 2000);
	if (remainingTime(deadline) === 0) return false;
	const listed = await runDockerAsync(binary, serviceContainerArgs(request), {
		cwd: request.root,
		signal: request.signal,
		timeoutMs: remainingTime(deadline),
	});
	const id = listed.ok ? uniqueContainerId(listed.stdout) : undefined;
	request.signal?.throwIfAborted();
	if (!id || remainingTime(deadline) === 0) return false;
	return (
		await runDockerAsync(binary, ["exec", id, ...request.command], {
			cwd: request.root,
			signal: request.signal,
			timeoutMs: remainingTime(deadline),
		})
	).ok;
}
