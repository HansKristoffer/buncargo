import type {
	ServiceDiagnosis,
	ServiceDiagnosisRequest,
} from "../container-runtime/types";
import { runDocker } from "./binary";
import { getComposeArgs } from "./compose-command";

/**
 * Why a compose service is not answering.
 *
 * Read through `docker compose ps --all`, which unlike `docker ps` still lists
 * a container that exited seconds after starting - the case this exists to
 * report.
 */

const DEFAULT_TAIL = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compose has emitted both a JSON array and one object per line depending on
 * the version, so accept either rather than pinning to the installed one.
 */
export function parseComposePs(stdout: string): Record<string, unknown>[] {
	const trimmed = stdout.trim();
	if (!trimmed) return [];

	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (Array.isArray(parsed)) return parsed.filter(isRecord);
		if (isRecord(parsed)) return [parsed];
	} catch {
		// Fall through to the line-delimited form.
	}

	const rows: Record<string, unknown>[] = [];
	for (const line of trimmed.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) rows.push(parsed);
		} catch {
			// A partial line is not worth failing a diagnostic over.
		}
	}
	return rows;
}

export function readComposeState(row: Record<string, unknown>): {
	state: string;
	exitCode?: number;
} {
	const state =
		typeof row.State === "string"
			? row.State
			: typeof row.Status === "string"
				? row.Status
				: "unknown";
	const rawExit = row.ExitCode;
	const exitCode = typeof rawExit === "number" ? rawExit : undefined;
	return { state, exitCode };
}

export function diagnoseDockerService(
	request: ServiceDiagnosisRequest,
	binary?: string,
): ServiceDiagnosis | undefined {
	const composeArgs = getComposeArgs({
		projectName: request.projectName,
		composeFile: request.composeFile,
	});

	const ps = runDocker(
		binary,
		[...composeArgs, "ps", "--all", "--format", "json", request.serviceName],
		{ cwd: request.root },
	);
	if (!ps.ok) return undefined;

	const row = parseComposePs(ps.stdout)[0];
	if (!row) return undefined;

	const { state, exitCode } = readComposeState(row);
	const logs = runDocker(
		binary,
		[
			...composeArgs,
			"logs",
			"--no-color",
			`--tail=${request.tail ?? DEFAULT_TAIL}`,
			request.serviceName,
		],
		{ cwd: request.root },
	);

	return {
		state,
		exitCode,
		logTail: logs.ok ? logs.stdout.trim() : "",
	};
}
