import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, resolve } from "node:path";
import { findMonorepoRoot } from "../core/ports";
import { shellQuote } from "../core/shell-quote";
import { workspaceId } from "../core/workspace-identity";
import type {
	AppConfig,
	BuncargoIntegration,
	EnvValues,
	IntegrationConfig,
} from "../types";
import { firebaseChecks } from "./checks";
import { resolveFirebaseBin } from "./cli";
import {
	anchorPort,
	emulatorEnv,
	emulatorPorts,
	FIREBASE_PUBLIC_ENV,
	type FirebaseEmulator,
	generatedFirebaseConfig,
	selectEmulators,
	suitePorts,
	uiEnabled,
} from "./emulators";
import {
	FIREBASE_GENERATED_CONFIG_FILE,
	type FirebaseProject,
	readFirebaseProject,
} from "./project";

/**
 * `buncargo/firebase`: the Firebase Emulator Suite, one per checkout.
 *
 * ```ts
 * import { firebase } from "buncargo/firebase";
 * integrations: [firebase({ publicEnvPrefix: "NEXT_PUBLIC_" })]
 * ```
 *
 * The emulators run as the `firebase` app. Their ports live in `firebase.json`
 * and nowhere else, so buncargo writes this checkout's copy beside it
 * (`firebase.buncargo.json`, every port moved by the checkout's offset) and
 * starts the CLI on that. The data is imported on start and exported on stop,
 * which is why the app gets a long stop grace.
 */

export {
	FIREBASE_DEFAULT_PORTS,
	FIREBASE_EMULATORS,
	type FirebaseEmulator,
} from "./emulators";
export {
	FIREBASE_GENERATED_CONFIG_FILE,
	type FirebaseProject,
	readFirebaseProject,
} from "./project";

declare module "../types/all-types" {
	interface IntegrationAppNames {
		firebase: true;
	}
}

/** The app the emulator suite runs as. */
export const FIREBASE_APP = "firebase";

/** Where the emulators' data is kept between runs, relative to the workdir. */
export const FIREBASE_DEFAULT_DATA_DIR = ".firebase-emulator-data";

/** Time to export the data on stop before the suite is killed. */
const DEFAULT_STOP_GRACE_MS = 60_000;

/** The first start downloads the emulators' jars. */
const READY_TIMEOUT_MS = 180_000;

export interface FirebaseIntegrationOptions {
	/** The directory holding `firebase.json`, relative to the monorepo root. Default: the root */
	workdir?: string;
	/**
	 * The project the emulators run as. Default: `.firebaserc`'s default
	 * project, else `demo-<projectPrefix>`. A `demo-` id can never reach a real
	 * Firebase project; any other id reaches it for products not emulated.
	 */
	projectId?: string;
	/**
	 * Emulators to start (`--only`). Default: every one `firebase.json`
	 * configures, except Hosting and App Hosting, which would serve the app
	 * buncargo already runs.
	 */
	emulators?: readonly FirebaseEmulator[];
	/**
	 * Prefixes for browser copies of the emulator hosts and project id:
	 * `"NEXT_PUBLIC_"`, `"VITE_"`, `["NEXT_PUBLIC_", "EXPO_PUBLIC_"]`.
	 */
	publicEnvPrefix?: string | readonly string[];
	/**
	 * Keep the emulators' data between runs: imported on start, exported on
	 * stop and restart. A directory relative to the workdir, or false to start
	 * empty every time. Default: `.firebase-emulator-data`. Delete the
	 * directory to start over.
	 */
	persist?: string | false;
	/** How long the suite gets to export its data on stop. Default: 60000 */
	stopGraceMs?: number;
}

/** Each variable again under every prefix, for browser code. */
function publicCopies(
	env: Record<string, string>,
	prefixes: readonly string[],
): Record<string, string> {
	return Object.fromEntries(
		prefixes.flatMap((prefix) =>
			FIREBASE_PUBLIC_ENV.flatMap((name) =>
				env[name] === undefined ? [] : [[`${prefix}${name}`, env[name]]],
			),
		),
	);
}

/**
 * The suite's temp dir, one per checkout (see `appEnv`). Short, under the
 * system's: the Functions emulator puts a Unix socket here, and a socket path
 * past 103 bytes (macOS) is cut off, which a deep worktree's root would do.
 */
export function emulatorTmpDir(root: string): string {
	return join(tmpdir(), `bcfb-${workspaceId(root).slice(0, 8)}`);
}

export function firebase(
	options: FirebaseIntegrationOptions = {},
): BuncargoIntegration {
	const workdirOption = options.workdir;
	const workdirOf = (root: string) => resolve(root, workdirOption ?? ".");
	const dataDir =
		options.persist === false
			? undefined
			: (options.persist ?? FIREBASE_DEFAULT_DATA_DIR);
	// Set in `config()`, which runs before anything below is called.
	let project: FirebaseProject | undefined;
	let selected: FirebaseEmulator[] = [];
	const projectOf = (root: string) => {
		project ??= readFirebaseProject(workdirOf(root));
		return project;
	};

	return {
		name: "firebase",

		config(config, ctx) {
			const root = ctx?.root ?? findMonorepoRoot();
			const read = readFirebaseProject(workdirOf(root));
			project = read;
			selected = selectEmulators(read.raw, options.emulators);
			const raw = read.raw;
			const projectId =
				options.projectId ??
				read.defaultProject ??
				`demo-${config.projectPrefix}`;
			const base = anchorPort(raw);
			// Every port moves by the offset the app's own port did.
			const offsetOf = (ports: Readonly<Record<string, number>>) =>
				(ports[FIREBASE_APP] ?? base) - base;
			const prefixes =
				typeof options.publicEnvPrefix === "string"
					? [options.publicEnvPrefix]
					: (options.publicEnvPrefix ?? []);

			const command = [
				shellQuote(resolveFirebaseBin(root, workdirOf(root))),
				"emulators:start",
				"--config",
				FIREBASE_GENERATED_CONFIG_FILE,
				"--project",
				shellQuote(projectId),
				...(selected.length > 0 ? ["--only", selected.join(",")] : []),
				...(dataDir
					? [
							"--import",
							shellQuote(dataDir),
							"--export-on-exit",
							shellQuote(dataDir),
						]
					: []),
			].join(" ");

			const apps: Record<string, AppConfig> = { ...(config.apps ?? {}) };
			apps[FIREBASE_APP] ??= {
				port: base,
				extraPorts: suitePorts(emulatorPorts(raw, selected, 0), base),
				devCommand: command,
				cwd: workdirOption,
				readyWhen: /All emulators ready/,
				healthTimeout: READY_TIMEOUT_MS,
				stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
			};

			const userEnv = config.env;
			return {
				...config,
				apps,
				generatedFiles: [
					...(config.generatedFiles ?? []),
					{
						path: normalize(
							join(workdirOption ?? ".", FIREBASE_GENERATED_CONFIG_FILE),
						),
						gitignore: true,
						render: (ctx) =>
							`${JSON.stringify(
								generatedFirebaseConfig(
									raw,
									selected,
									emulatorPorts(raw, selected, offsetOf(ctx.ports)),
								),
								null,
								2,
							)}\n`,
					},
				],
				env: (ports, urls, ctx): EnvValues => {
					const env = emulatorEnv(
						selected,
						emulatorPorts(
							raw,
							selected,
							offsetOf(ports as Record<string, number>),
						),
						projectId,
					);
					return {
						...env,
						...publicCopies(env, prefixes),
						...userEnv?.(ports, urls, ctx),
					};
				},
			} as IntegrationConfig;
		},

		// The hub announces itself in `$TMPDIR/hub-<project id>.json`. With one
		// shared temp dir, two checkouts on the same project id read each
		// other's hub, so each gets its own.
		appEnv: (app) =>
			app.name === FIREBASE_APP
				? { TMPDIR: emulatorTmpDir(app.root) }
				: undefined,

		hooks: {
			async beforeServers(ctx) {
				mkdirSync(emulatorTmpDir(ctx.root), { recursive: true });
			},
		},

		bannerHint: (app) =>
			app.name === FIREBASE_APP && selected.length > 0
				? selected.join(", ")
				: undefined,

		checks: firebaseChecks({
			project: projectOf,
			workdir: workdirOf,
			emulators: (root) =>
				selectEmulators(projectOf(root).raw, options.emulators),
			dataDir: () => dataDir && normalize(join(workdirOption ?? ".", dataDir)),
		}),

		describe: (ctx) => {
			const url = (ctx.urls as Record<string, string>)[FIREBASE_APP];
			const rows: Record<string, string> = {};
			if (url && project && uiEnabled(project.raw))
				rows["Firebase Emulator UI"] = url;
			return rows;
		},
	};
}
