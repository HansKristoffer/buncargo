import { serviceContainerOf } from "../container-runtime/containers";
import type {
	ServiceDiagnosis,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import { remainingTime } from "../core/deadline";
import { runDockerAsync } from "./binary";
import { listDockerContainersAsync } from "./containers";

/**
 * Why a compose service is not answering.
 *
 * Found in the one container listing, which still lists a container that
 * exited seconds after starting - the case this exists to report. Not
 * `docker compose ps`: Compose reparsing the project can overrun the
 * two-second budget (the same reason `exec.ts` avoids `docker compose exec`).
 */

const DEFAULT_TAIL = 20;

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
		const container = serviceContainerOf(
			await listDockerContainersAsync(binary, options()),
			request.projectName,
			request.serviceName,
		);
		if (!container) return undefined;
		const state = {
			state: container.runtimeState,
			...(container.exitCode === undefined
				? {}
				: { exitCode: container.exitCode }),
		};
		if (remainingTime(deadline) === 0) return { ...state, logTail: "" };
		const logs = await runDockerAsync(
			binary,
			["logs", `--tail=${request.tail ?? DEFAULT_TAIL}`, container.id],
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
