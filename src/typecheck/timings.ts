import { join } from "node:path";
import {
	type JsonValidator,
	readJsonDocument,
	writeJsonDocument,
} from "../core/registry-file";
import { STATE_DIRNAME } from "../core/state-paths";

export const TYPECHECK_TIMINGS_VERSION = 1;
export const TYPECHECK_TIMINGS_FILE = join(
	STATE_DIRNAME,
	"typecheck-timings.json",
);

export interface TypecheckTimingsFile {
	version: typeof TYPECHECK_TIMINGS_VERSION;
	timings: Record<string, number>;
}

const validateTimings: JsonValidator<TypecheckTimingsFile> = (value) => {
	if (typeof value !== "object" || value === null) return undefined;
	const file = value as Record<string, unknown>;
	if (file.version !== TYPECHECK_TIMINGS_VERSION) return undefined;
	const raw = file.timings;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return undefined;
	}
	const timings: Record<string, number> = {};
	for (const [path, duration] of Object.entries(raw)) {
		if (
			typeof duration === "number" &&
			Number.isFinite(duration) &&
			duration >= 0
		) {
			timings[path] = duration;
		}
	}
	return { version: TYPECHECK_TIMINGS_VERSION, timings };
};

export async function readTypecheckTimings(
	root: string,
): Promise<Record<string, number>> {
	const parsed = await readJsonDocument(
		join(root, TYPECHECK_TIMINGS_FILE),
		validateTimings,
	);
	return parsed?.timings ?? {};
}

/**
 * Merge this run's durations into the cache. Workspaces not run (`--only`)
 * keep their previous times so the next full schedule stays longest-first.
 */
export async function writeTypecheckTimings(
	root: string,
	previous: Readonly<Record<string, number>>,
	results: ReadonlyArray<{ workspace: string; duration: number }>,
): Promise<void> {
	const timings = { ...previous };
	for (const result of results) {
		timings[result.workspace] = result.duration;
	}
	await writeJsonDocument(join(root, TYPECHECK_TIMINGS_FILE), {
		version: TYPECHECK_TIMINGS_VERSION,
		timings,
	} satisfies TypecheckTimingsFile);
}
