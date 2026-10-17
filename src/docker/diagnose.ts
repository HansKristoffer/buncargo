import type {
	ServiceDiagnosis,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import { runDockerAsync } from "./binary";
import { serviceContainerFilters } from "./exec";

/**
 * Why a compose service is not answering.
 *
 * Resolved by Compose's labels with `docker ps --all`, which still lists a
 * container that exited seconds after starting - the case this exists to
 * report. Not `docker compose ps`: readiness calls this on every poll for a
 * service without a port, and Compose reparsing the project can overrun the
 * two-second budget (the same reason `exec.ts` avoids `docker compose exec`).
 */

const DEFAULT_TAIL = 20;

/** One `{{.ID}}\t{{.State}}\t{{.Status}}` line; the exit code only `Status` carries. */
export function parseDockerPsState(
	line: string,
): { id: string; state: string; exitCode?: number } | undefined {
	const [id, state, status = ""] = line.trim().split("\t");
	if (!id || !state) return undefined;
	const exit = /^Exited \((\d+)\)/i.exec(status)?.[1];
	return { id, state, exitCode: exit === undefined ? undefined : Number(exit) };
}

export async function diagnoseDockerService(
	request: ServiceDiagnosisRequest,
	binary?: string,
): Promise<ServiceDiagnosis | undefined> {
	const deadline = performance.now() + (request.timeoutMs ?? 2000);
	const options = () => ({
		cwd: request.root,
		signal: request.signal,
		timeoutMs: remainingTime(deadline),
	});
	try {
		const ps = await runDockerAsync(
			binary,
			[
				"ps",
				"--all",
				...serviceContainerFilters(request),
				"--format",
				"{{.ID}}\t{{.State}}\t{{.Status}}",
			],
			options(),
		);
		const first = ps.stdout.trim().split("\n")[0] ?? "";
		const found = ps.ok ? parseDockerPsState(first) : undefined;
		if (!found) return undefined;
		const { id, ...state } = found;
		if (remainingTime(deadline) === 0) return { ...state, logTail: "" };
		const logs = await runDockerAsync(
			binary,
			["logs", `--tail=${request.tail ?? DEFAULT_TAIL}`, id],
			options(),
		);
		// The container writes its own stderr there too, and that is usually
		// where a startup failure explains itself.
		const output = `${logs.stdout}${logs.stderr}`.trim();
		return { ...state, logTail: logs.ok ? output : "" };
	} catch {
		return undefined;
	}
}
