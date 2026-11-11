import { buncargoContainersOf } from "../container-runtime/containers";
import type { BuncargoContainer } from "../types";
import { runDockerAsync } from "./binary";
import { parseDockerContainer } from "./containers";

/** One line of the Docker listing, or null for a container buncargo did not create. */
export function parseDockerContainerLine(
	line: string,
): BuncargoContainer | null {
	const container = parseDockerContainer(line);
	return container
		? (buncargoContainersOf([container], "docker")[0] ?? null)
		: null;
}

export async function stopDockerContainersByIds(
	ids: string[],
	binary?: string,
): Promise<void> {
	if (ids.length === 0) return;
	const result = await runDockerAsync(binary, ["stop", ...ids], {
		inherit: true,
		timeoutMs: 60_000,
	});
	if (!result.ok) {
		throw new Error(
			result.stderr.trim() || `docker stop failed for ${ids.join(", ")}`,
		);
	}
}
