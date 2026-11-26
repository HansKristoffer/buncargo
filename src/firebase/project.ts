import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getErrorMessage, isRecord } from "hanzio";

/** The Firebase CLI's default config file. */
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
	/** Absolute path of the Firebase config file, whether or not it exists. */
	path: string;
	exists: boolean;
	/** Why an existing config file could not be read; it is treated as empty meanwhile. */
	error?: string;
	/** The whole file, so the generated copy keeps every other setting. */
	raw: Record<string, unknown>;
	/** `.firebaserc`'s `projects.default`. */
	defaultProject?: string;
}

function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function readDefaultProject(dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		try {
			const rc = record(
				Bun.JSONC.parse(readFileSync(join(dir, ".firebaserc"), "utf8")),
			);
			const project = record(rc.projects).default;
			if (typeof project === "string" && project) return project;
		} catch {
			// No `.firebaserc` here, or one that does not parse: try the next directory.
		}
	}
	return undefined;
}

/**
 * Read `<workdir>/<configFile>`, leniently: without one (CI, a fresh clone),
 * or with one that does not parse, the config still loads and a check reports
 * it, rather than every command failing. Comments are allowed, as the CLI
 * allows them.
 */
export function readFirebaseProject(
	workdir: string,
	configFile: string = FIREBASE_CONFIG_FILE,
): FirebaseProject {
	const path = join(workdir, configFile);
	const configDir = dirname(path);
	const rcDirs = configDir === workdir ? [workdir] : [configDir, workdir];
	const defaultProject = readDefaultProject(rcDirs);

	if (!existsSync(path)) {
		return { path, exists: false, raw: {}, defaultProject };
	}

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
			error: getErrorMessage(error),
		};
	}
}
