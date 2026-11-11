import { portOwnersOf } from "../container-runtime/containers";
import type { PortContainerOwner } from "../types";
import { listDockerContainers, listDockerContainersAsync } from "./containers";

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
 * Which container is publishing each host port, from one `docker ps`. A
 * Docker that cannot answer names no container; the port's process owner
 * still does.
 */
export function dockerContainerPortOwners(
	binary?: string,
): Map<number, PortContainerOwner> {
	try {
		return portOwnersOf(listDockerContainers(binary));
	} catch {
		return new Map();
	}
}

export async function dockerContainerPortOwnersAsync(
	binary?: string,
	signal?: AbortSignal,
): Promise<Map<number, PortContainerOwner>> {
	try {
		return portOwnersOf(await listDockerContainersAsync(binary, { signal }));
	} catch {
		signal?.throwIfAborted();
		return new Map();
	}
}

export function findDockerContainerOnPort(
	port: number,
	binary?: string,
): PortContainerOwner | undefined {
	return dockerContainerPortOwners(binary).get(port);
}
