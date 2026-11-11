import { buncargoContainersOf } from "../container-runtime/containers";
import type { BuncargoContainer } from "../types";
import { runDocker } from "./binary";
import { listDockerContainers, parseDockerContainer } from "./containers";

/** One line of the Docker listing, or null for a container buncargo did not create. */
export function parseDockerContainerLine(
	line: string,
): BuncargoContainer | null {
	const container = parseDockerContainer(line);
	return container
		? (buncargoContainersOf([container], "docker")[0] ?? null)
		: null;
}

/** Every container (running or not) labeled by buncargo on this machine. */
export function listDockerBuncargoContainers(
	binary?: string,
): BuncargoContainer[] {
	return buncargoContainersOf(listDockerContainers(binary), "docker");
}

export function stopDockerContainersByIds(
	ids: string[],
	binary?: string,
): void {
	if (ids.length === 0) return;
	const result = runDocker(binary, ["stop", ...ids], { inherit: true });
	if (!result.ok) {
		throw new Error(
			result.stderr.trim() || `docker stop failed for ${ids.join(", ")}`,
		);
	}
}
