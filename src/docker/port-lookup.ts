import type { PortContainerOwner } from "../types";
import { runDocker } from "./binary";

const LIST_ARGS = [
	"ps",
	"--format",
	'{{.ID}}\t{{.Names}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}',
];

export function parseDockerPublishedPort(
	portsField: string,
	port: number,
): boolean {
	const pattern = new RegExp(
		`(?:^|,|\\s)(?:\\[::\\]|0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\*):${port}->`,
	);
	return pattern.test(portsField) || new RegExp(`:${port}->`).test(portsField);
}

/**
 * Every host port a `{{.Ports}}` field publishes.
 *
 * The field is a comma-separated list of `<address>:<host>-><container>/<proto>`
 * entries, with unpublished ports appearing as a bare `5432/tcp`. Only the
 * mapped ones are reachable from the host, so only those can be holding one of
 * ours.
 */
export function parseDockerPublishedPorts(portsField: string): number[] {
	const ports: number[] = [];
	for (const match of portsField.matchAll(/:(\d{1,5})->/g)) {
		const port = Number.parseInt(match[1] ?? "", 10);
		if (Number.isInteger(port) && port > 0 && !ports.includes(port)) {
			ports.push(port);
		}
	}
	return ports;
}

/**
 * Which container is publishing each host port, from one `docker ps`.
 *
 * Built as a map rather than searched per port: the port allocator, the
 * service preflight and the app classifier each ask about several ports, and
 * running `docker ps` once per question was most of a dev run's fork count.
 */
export function dockerContainerPortOwners(
	binary?: string,
): Map<number, PortContainerOwner> {
	const owners = new Map<number, PortContainerOwner>();
	const result = runDocker(binary, LIST_ARGS);
	if (!result.ok) return owners;

	for (const line of result.stdout.trim().split("\n")) {
		if (!line) continue;
		const [id, name, portsField, composeProject] = line.split("\t");
		if (!id || !portsField) continue;
		const owner: PortContainerOwner = {
			id,
			name: name ?? id,
			composeProject: composeProject || undefined,
		};
		for (const port of parseDockerPublishedPorts(portsField)) {
			// First writer wins, matching the old scan, which returned the first
			// container `docker ps` listed.
			if (!owners.has(port)) owners.set(port, owner);
		}
	}

	return owners;
}

export function findDockerContainerOnPort(
	port: number,
	binary?: string,
): PortContainerOwner | undefined {
	return dockerContainerPortOwners(binary).get(port);
}
