import { parseContainerState } from "../container-runtime/container-state";
import type { RuntimeContainer } from "../container-runtime/types";
import { SERVICE_HASH_LABEL } from "../docker-compose/interpolate";
import { type DockerRunResult, runDocker, runDockerAsync } from "./binary";

/**
 * Docker's one container listing: every container, buncargo's or not, with
 * the state, the status line, the published ports and the labels buncargo
 * reads. Service states, port owners, the inventory and a service's state are
 * all projections of it (`container-runtime/containers.ts`).
 *
 * `--all` with the state, so whether a container holds its ports is decided by
 * `isContainerLive` like everywhere else rather than by `docker ps`'s default
 * filter: a paused or restarting container keeps, or takes back, its ports.
 */
const LABELS = [
	"com.docker.compose.project",
	"com.docker.compose.oneoff",
	"buncargo.project",
	"buncargo.root",
	"buncargo.worktree",
	"buncargo.service",
	SERVICE_HASH_LABEL,
] as const;

export const DOCKER_LIST_ARGS = [
	"ps",
	"--all",
	"--format",
	[
		"{{.ID}}",
		"{{.Names}}",
		"{{.State}}",
		"{{.Status}}",
		"{{.Ports}}",
		...LABELS.map((label) => `{{.Label "${label}"}}`),
	].join("\t"),
];

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

/**
 * Every host port a `{{.Ports}}` field publishes.
 *
 * The field is a comma-separated list of `<address>:<host>-><container>/<proto>`
 * entries, a range as `<address>:8000-8002->8000-8002/tcp`, and unpublished
 * ports as a bare `5432/tcp`. Only the mapped ones are reachable from the
 * host, so only those can be holding one of ours.
 */
export function parseDockerPublishedPorts(portsField: string): number[] {
	const ports: number[] = [];
	for (const match of portsField.matchAll(/:(\d{1,5})(?:-(\d{1,5}))?->/g)) {
		const first = Number.parseInt(match[1] ?? "", 10);
		const last = match[2] === undefined ? first : Number.parseInt(match[2], 10);
		for (let port = first; port <= last; port++)
			if (port > 0 && !ports.includes(port)) ports.push(port);
	}
	return ports;
}

/**
 * The container port behind each published host port that differs from it:
 * `127.0.0.1:55001->5432/tcp` maps 55001 to 5432. A range maps
 * position by position.
 */
function parseDockerTargetPorts(portsField: string): Record<number, number> {
	const targets: Record<number, number> = {};
	for (const match of portsField.matchAll(
		/:(\d{1,5})(?:-(\d{1,5}))?->(\d{1,5})(?:-\d{1,5})?\//g,
	)) {
		const first = Number.parseInt(match[1] ?? "", 10);
		const last = match[2] === undefined ? first : Number.parseInt(match[2], 10);
		const target = Number.parseInt(match[3] ?? "", 10);
		for (let port = first; port <= last; port++) {
			const mapped = target + (port - first);
			if (mapped !== port) targets[port] = mapped;
		}
	}
	return targets;
}

/** One line of {@link DOCKER_LIST_ARGS} output, or undefined for one without an id. */
export function parseDockerContainer(
	line: string,
): RuntimeContainer | undefined {
	const [id, name, state = "", status = "", portsText = "", ...labels] = line
		.replace(/\r$/, "")
		.split("\t");
	if (!id) return undefined;
	const [composeProject, oneOff, project, root, worktree, service, hash] =
		labels;
	const healthy = parseDockerHealth(status);
	const exitCode = parseDockerExitCode(status);
	const targetPorts = parseDockerTargetPorts(portsText);
	return {
		id,
		name: name || id,
		state: parseContainerState(state),
		runtimeState: state,
		status,
		...(healthy === undefined ? {} : { healthy }),
		...(exitCode === undefined ? {} : { exitCode }),
		ports: parseDockerPublishedPorts(portsText),
		...(Object.keys(targetPorts).length > 0 ? { targetPorts } : {}),
		portsText,
		labels: {
			...(composeProject ? { composeProject } : {}),
			...(project ? { project } : {}),
			...(root ? { root } : {}),
			...(worktree ? { worktree } : {}),
			// A `compose run` container carries the service's labels without
			// being its replica.
			...(service && oneOff !== "True" ? { service } : {}),
			...(hash ? { serviceHash: hash } : {}),
		},
	};
}

function containersFrom(result: DockerRunResult): RuntimeContainer[] {
	// A daemon that cannot answer throws: "no containers" is something the
	// watch and the sweep act on, and "could not ask" must not read as it.
	if (!result.ok)
		throw new Error(
			result.stderr.trim() || `docker ps exited ${result.exitCode}`,
		);
	return result.stdout.split("\n").flatMap((line) => {
		const container = parseDockerContainer(line);
		return container ? [container] : [];
	});
}

/** Every container, in one `docker ps`. Throws when Docker cannot answer. */
export function listDockerContainers(binary?: string): RuntimeContainer[] {
	return containersFrom(runDocker(binary, DOCKER_LIST_ARGS));
}

/** {@link listDockerContainers}, cancellable: what startup paths use. */
export async function listDockerContainersAsync(
	binary?: string,
	options: { signal?: AbortSignal; timeoutMs?: number; cwd?: string } = {},
): Promise<RuntimeContainer[]> {
	return containersFrom(
		await runDockerAsync(binary, DOCKER_LIST_ARGS, options),
	);
}
