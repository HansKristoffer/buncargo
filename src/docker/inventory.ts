import { runDockerAsync } from "./binary";

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
