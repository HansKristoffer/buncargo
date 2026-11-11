import type { ContainerLogsRequest } from "../container-runtime/types";
import { runDockerAsync } from "./binary";

/**
 * `docker logs` of one container, found by the id the listing gave. Not
 * `docker compose logs`: Compose reparsing the project can overrun the
 * two-second budget (the same reason `exec.ts` avoids `docker compose exec`).
 */
export async function dockerContainerLogs(
	request: ContainerLogsRequest,
	binary?: string,
): Promise<string> {
	try {
		const logs = await runDockerAsync(
			binary,
			["logs", `--tail=${request.tail}`, request.id],
			{
				cwd: request.root,
				signal: request.signal,
				timeoutMs: request.timeoutMs,
			},
		);
		// The container writes its own stderr there too, and that is usually
		// where a startup failure explains itself.
		return logs.ok ? `${logs.stdout}${logs.stderr}`.trim() : "";
	} catch {
		return "";
	}
}
