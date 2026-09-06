import type { ExecInServiceRequest } from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import { runDocker, runDockerAsync } from "./binary";

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

/**
 * Probe the running container directly. Compose reparses the whole project on
 * every exec and can take longer than the probe's two-second budget even when
 * Postgres is ready. Resolve by labels, not a guessed name or a cached ID, so
 * custom names, aliases and container recreation still target the right one.
 */
export function execInDockerService(
	request: ExecInServiceRequest,
	binary?: string,
): boolean {
	request.signal?.throwIfAborted();
	const deadline = performance.now() + (request.timeoutMs ?? 2000);
	if (remainingTime(deadline) === 0) return false;
	const listed = runDocker(binary, serviceContainerArgs(request), {
		cwd: request.root,
		timeoutMs: Math.max(1, Math.ceil(remainingTime(deadline))),
	});
	const id = listed.ok ? uniqueContainerId(listed.stdout) : undefined;
	request.signal?.throwIfAborted();
	if (!id || remainingTime(deadline) === 0) return false;
	return runDocker(binary, ["exec", id, ...request.command], {
		cwd: request.root,
		timeoutMs: Math.max(1, Math.ceil(remainingTime(deadline))),
	}).ok;
}

export async function execInDockerServiceAsync(
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
