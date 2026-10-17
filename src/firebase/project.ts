import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The Firebase CLI's config file. */
export const FIREBASE_CONFIG_FILE = "firebase.json";

/**
 * Where this checkout's copy of `firebase.json`, with its own ports, is
 * written. Beside the original rather than under `.buncargo/`: the CLI takes
 * the config file's directory as the project directory, and refuses a
 * `functions.source` outside it.
 */
export const FIREBASE_GENERATED_CONFIG_FILE = "firebase.buncargo.json";

/** What the integration reads from a project's `firebase.json` and `.firebaserc`. */
export interface FirebaseProject {
	/** Absolute path of `firebase.json`, whether or not it exists. */
	path: string;
	exists: boolean;
	/** Why an existing `firebase.json` could not be read; it is treated as empty meanwhile. */
	error?: string;
	/** The whole file, so the generated copy keeps every other setting. */
	raw: Record<string, unknown>;
	/** `.firebaserc`'s `projects.default`. */
	defaultProject?: string;
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function readDefaultProject(workdir: string): string | undefined {
	try {
		const rc = record(
			Bun.JSONC.parse(readFileSync(join(workdir, ".firebaserc"), "utf8")),
		);
		const project = record(rc.projects).default;
		return typeof project === "string" && project ? project : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read `<workdir>/firebase.json`, leniently: without one (CI, a fresh clone),
 * or with one that does not parse, the config still loads and a check reports
 * it, rather than every command failing. Comments are allowed, as the CLI
 * allows them.
 */
export function readFirebaseProject(workdir: string): FirebaseProject {
	const path = join(workdir, FIREBASE_CONFIG_FILE);
	const defaultProject = readDefaultProject(workdir);
	if (!existsSync(path))
		return { path, exists: false, raw: {}, defaultProject };
	try {
		return {
			path,
			exists: true,
			raw: record(Bun.JSONC.parse(readFileSync(path, "utf8"))),
			defaultProject,
		};
	} catch (error) {
		return {
			path,
			exists: true,
			raw: {},
			defaultProject,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
