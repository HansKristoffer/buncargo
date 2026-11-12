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
 * Which Docker container is publishing each host port, from one `docker ps`:
 * for the port-owner lookups that name no runtime, and the synchronous ones,
 * which only ever ask Docker. A Docker that cannot answer names no container;
 * the port's process owner still does.
 */
export function dockerContainerPortOwners(
	binary?: string,
): Map<number, PortContainerOwner> {
	try {
		return portOwnersOf(listDockerContainers(binary), "docker");
	} catch {
		return new Map();
	}
}

export async function dockerContainerPortOwnersAsync(
	signal?: AbortSignal,
): Promise<Map<number, PortContainerOwner>> {
	try {
		return portOwnersOf(
			await listDockerContainersAsync(undefined, { signal }),
			"docker",
		);
	} catch {
		signal?.throwIfAborted();
		return new Map();
	}
}
