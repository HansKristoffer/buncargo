import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { isRecord, safeJsonParse } from "hanzio";
import { publicEnvCopies } from "../core/integration-cli";
import { findMonorepoRoot } from "../core/ports";
import { isProcessAlive } from "../core/process/lifecycle";
import {
	describeSecretsError,
	isScopeList,
	loadScopeSecrets,
	missingKeys,
	readInfisicalProjectId,
	requiredSecretKeys,
	resolveScopes,
	stopsTheRun,
	warnSecretsOnce,
} from "../core/secrets/index";
import { shellQuote } from "../core/shell-quote";
import { projectStateFilePath } from "../core/state-paths";
import { formatWarn } from "../core/style";
import { workspaceId } from "../core/workspace-identity";
import type {
	AppConfig,
	BuncargoIntegration,
	EnvValues,
	HookContext,
	IntegrationConfig,
	SecretsScopeInput,
	ServiceConfig,
} from "../types";
import { firebaseChecks } from "./checks";
import { firebaseCli } from "./cli";
import {
	anchorPort,
	emulatorEnv,
	emulatorPorts,
	FIREBASE_PUBLIC_ENV,
	type FirebaseEmulator,
	firebaseWebConfig,
	generatedFirebaseConfig,
	selectEmulators,
	suitePorts,
	uiEnabled,
	unselectedEmulatorEnv,
} from "./emulators";
import {
	type FunctionsEnvHandle,
	renderFunctionsEnvFile,
	resolveFunctionsSourceDir,
	writeFunctionsEnvFile,
} from "./functions-env";
import {
	emulatorCloudSdkDir,
	isBrokenJavaHome,
	mergeJavaToolOptions,
	resolveJavaHeap,
} from "./jvm";
import {
	FIREBASE_CONFIG_FILE,
	FIREBASE_GENERATED_CONFIG_FILE,
	type FirebaseProject,
	readFirebaseProject,
} from "./project";
import { ensurePubsubTopics } from "./pubsub";

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
	firebaseWebConfig,
	UNREACHABLE_EMULATOR_HOST,
} from "./emulators";
export {
	BUNCARGO_FUNCTIONS_ENV_HEADER,
	isReservedFunctionsEnvKey,
	isValidFunctionsEnvKey,
	renderFunctionsEnvFile,
	resolveFunctionsSourceDir,
	serializeFunctionsEnvEntry,
} from "./functions-env";
export {
	FIREBASE_CONFIG_FILE,
	FIREBASE_GENERATED_CONFIG_FILE,
	type FirebaseProject,
	readFirebaseProject,
} from "./project";
export { ensurePubsubTopics } from "./pubsub";

/** The app the emulator suite runs as. */
export const FIREBASE_APP = "firebase";

/** Where the emulators' data is kept between runs, relative to the workdir. */
export const FIREBASE_DEFAULT_DATA_DIR = ".firebase-emulator-data";

/** Time to export the data on stop before the suite is killed. */
const DEFAULT_STOP_GRACE_MS = 60_000;

/** The first start downloads the emulators' jars. */
const READY_TIMEOUT_MS = 180_000;

/** Options for rendering a Cloud Functions `.env` file before emulators start. */
export interface FirebaseFunctionsEnvOptions {
	/**
	 * Output path relative to the Firebase workdir. Default:
	 * `<functions.source>/.env` (read from `firebase.json`, falling back to
	 * `functions/.env`).
	 */
	path?: string;
	/** Infisical scope (or layered scopes) to fetch and render into `.env`. */
	secrets?: SecretsScopeInput;
	/**
	 * Extra static or computed values merged on top of fetched secrets.
	 * Firebase reserved keys and `exclude` patterns are still stripped.
	 */
	values?:
		| EnvValues
		| ((
				ctx: HookContext<
					Record<string, ServiceConfig>,
					Record<string, AppConfig>
				>,
		  ) => EnvValues);
	/** Exact key names or glob patterns (`*`, `?`) stripped from the file (e.g. `FB_PRIVATE_KEY_*`). */
	exclude?: readonly string[];
	/** Keep the generated `.env` on disk after stop (default: `false`, removes or restores backup). */
	keepOnExit?: boolean;
}

export interface FirebaseIntegrationOptions {
	/** The directory holding `firebase.json`, relative to the monorepo root. Default: the root */
	workdir?: string;
	/** Firebase config file relative to `workdir`. Default: `"firebase.json"`. */
	configFile?: string;
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
	 * What the emulator variables of an emulator the web SDK dials (auth,
	 * Firestore, Realtime Database, Storage, Functions) hold when this run
	 * does not start it. `"unreachable"` sets them to `127.0.0.1:9`, where
	 * nothing answers, so a client fails at once instead of falling back to
	 * the SDK's default port, which may be another checkout's emulator.
	 * `"unset"` leaves them out, for a project that reaches the real product.
	 * `publicEnvPrefix` copies follow. Default: `"unreachable"` when the
	 * project id starts with `"demo-"` (which can reach nothing real), else
	 * `"unset"`.
	 */
	unselectedEmulators?: "unreachable" | "unset";
	/**
	 * Variable to write the browser SDK's config into, as JSON for
	 * `initializeApp`: the emulated `projectId`, a fake `apiKey`,
	 * `authDomain: "localhost"` and `storageBucket: "<projectId>.appspot.com"`
	 * (`"NEXT_PUBLIC_FIREBASE_CONFIG"`). Written as named, without
	 * `publicEnvPrefix`.
	 */
	webConfigEnv?: string;
	/**
	 * Keep the emulators' data between runs: imported on start, exported on
	 * stop and restart. A directory relative to the workdir, or false to start
	 * empty every time. Default: `.firebase-emulator-data`. Delete the
	 * directory to start over.
	 */
	persist?: string | false;
	/** How long the suite gets to export its data on stop. Default: 60000 */
	stopGraceMs?: number;
	/**
	 * JVM max heap injected via `JAVA_TOOL_OPTIONS` (`-Xmx<size>`) for the
	 * `firebase` app. `"auto"` uses half of system RAM in GiB (floored, clamped
	 * to `1g..8g`); or pass an explicit size like `"6g"`. Preserves existing
	 * `JAVA_TOOL_OPTIONS` and skips if `-Xmx` is already set.
	 */
	javaHeap?: "auto" | (string & {});
	/**
	 * Clear `GOOGLE_APPLICATION_CREDENTIALS` and point `CLOUDSDK_CONFIG` at an
	 * empty directory inside the emulator temp dir for the `firebase` app,
	 * sibling apps, and exported link env, so developer `gcloud` / ADC
	 * credentials never leak into local demo emulators.
	 * Default: `true` when `projectId` starts with `"demo-"`, else `false`.
	 */
	isolateCredentials?: boolean;
	/**
	 * Pub/Sub topics created idempotently against the Pub/Sub emulator as soon
	 * as `firebase` becomes ready, before downstream `startAfter` apps or
	 * `seed.afterApps` run.
	 */
	pubsubTopics?: readonly string[];
	/**
	 * Render a filtered, `0o600`-mode `.env` file for the Cloud Functions
	 * emulator before servers start (and restore/remove it on exit).
	 */
	functionsEnv?: FirebaseFunctionsEnvOptions;
}

/**
 * Longest Unix domain socket the Functions emulator creates inside `TMPDIR`,
 * and macOS's `sockaddr_un.sun_path` limit (103 bytes + NUL).
 */
const MAX_UNIX_SOCKET_BYTES = 103;
const FUNCTIONS_SOCKET_RESERVE = `/fire_emu_${"0".repeat(16)}.sock`.length;

/**
 * The suite's temp dir, one per checkout (see `appEnv`). Short, under the
 * system's: the Functions emulator puts a Unix socket here, and a socket path
 * past 103 bytes (macOS) is cut off, which a deep worktree's root or a long
 * sandbox `TMPDIR` would do. Falls back to `/tmp` when `tmpdir()` leaves no
 * room for the socket name.
 */
export function emulatorTmpDir(root: string): string {
	const folder = `bcfb-${workspaceId(root).slice(0, 8)}`;
	const preferred = join(tmpdir(), folder);
	const preferredBytes =
		Buffer.byteLength(preferred) + FUNCTIONS_SOCKET_RESERVE;
	if (preferredBytes <= MAX_UNIX_SOCKET_BYTES || process.platform === "win32") {
		return preferred;
	}
	return join("/tmp", folder);
}

/**
 * A hub locator whose suite is gone. A suite removes its own on a clean
 * stop; one killed after the stop grace leaves it naming a pid that no
 * longer runs, and the next suite in the checkout reads it as a hub already
 * running. One without a pid cannot be checked and is left to the CLI.
 */
export function isStaleHubLocator(
	content: string,
	isAlive: (pid: number) => boolean,
): boolean {
	const parsed = safeJsonParse(content);
	const pid = parsed.ok && isRecord(parsed.data) ? parsed.data.pid : undefined;
	const known = typeof pid === "number" && Number.isInteger(pid) && pid > 0;
	return known && !isAlive(pid);
}

/** Remove the checkout's stale `hub-<project id>.json` before its suite starts. */
function removeStaleHubLocators(dir: string): void {
	for (const name of readdirSync(dir)) {
		if (!/^hub-.+\.json$/.test(name)) continue;
		const path = join(dir, name);
		try {
			const content = readFileSync(path, "utf8");
			if (isStaleHubLocator(content, isProcessAlive)) {
				rmSync(path, { force: true });
			}
		} catch {
			// Gone already, or unreadable: the CLI reports what it makes of it.
		}
	}
}

interface FirebaseRootState {
	readonly project: FirebaseProject;
	readonly selected: FirebaseEmulator[];
	readonly resolvedProjectId: string;
	readonly configSecrets: SecretsScopeInput | false | undefined;
}

function attachProjectIdIfMissing(
	input: SecretsScopeInput,
	projectId: string,
): SecretsScopeInput {
	if (isScopeList(input)) {
		const [first, ...rest] = input;
		if (!first || first.projectId) return input;
		return [{ ...first, projectId }, ...rest];
	}
	return input.projectId ? input : { ...input, projectId };
}

export function firebase(
	options: FirebaseIntegrationOptions = {},
): BuncargoIntegration<{ apps: typeof FIREBASE_APP }> {
	const workdirOption = options.workdir;
	const configFile = options.configFile ?? FIREBASE_CONFIG_FILE;
	const resolvedJavaHeap = resolveJavaHeap(options.javaHeap, totalmem());
	// Beside the configured file: `--config` makes its directory the project
	// directory where `functions.source` and rules paths resolve from.
	const generatedConfigInWorkdir = normalize(
		join(dirname(configFile), FIREBASE_GENERATED_CONFIG_FILE),
	);
	const workdirOf = (root: string) => resolve(root, workdirOption ?? ".");
	const dataDir =
		options.persist === false
			? undefined
			: (options.persist ?? FIREBASE_DEFAULT_DATA_DIR);

	// Keyed by checkout root so sharing one `firebase()` instance across
	// `withProfile()`, `withSuffix()`, or multiple checkouts never clobbers state.
	const stateByRoot = new Map<string, FirebaseRootState>();
	const activeFunctionsEnvByPath = new Map<string, FunctionsEnvHandle>();
	let lastRoot: string | undefined;

	const projectOf = (root: string): FirebaseProject => {
		const existing = stateByRoot.get(root);
		if (existing) return existing.project;
		return readFirebaseProject(workdirOf(root), configFile);
	};

	const stateOf = (root: string): FirebaseRootState | undefined =>
		stateByRoot.get(root) ?? (lastRoot ? stateByRoot.get(lastRoot) : undefined);

	const shouldIsolateCredentials = (root?: string) => {
		const state = root
			? stateOf(root)
			: lastRoot
				? stateOf(lastRoot)
				: undefined;
		const activeProjectId =
			state?.resolvedProjectId ??
			options.projectId ??
			state?.project.defaultProject;
		return (
			options.isolateCredentials ??
			activeProjectId?.startsWith("demo-") ??
			false
		);
	};

	const isActiveForProfile = (activeApps: ReadonlySet<string> | undefined) =>
		activeApps === undefined || activeApps.has(FIREBASE_APP);

	const functionsEnvRelPath = (root: string): string | undefined => {
		const fnEnv = options.functionsEnv;
		if (!fnEnv) return undefined;
		const currentProject = projectOf(root);
		const targetRel =
			fnEnv.path ??
			join(
				dirname(configFile),
				resolveFunctionsSourceDir(currentProject.raw),
				".env",
			);
		return normalize(join(workdirOption ?? ".", targetRel));
	};

	const functionsEnvAbsPath = (root: string): string | undefined => {
		const fnEnv = options.functionsEnv;
		if (!fnEnv) return undefined;
		const currentProject = projectOf(root);
		const targetRel =
			fnEnv.path ??
			join(
				dirname(configFile),
				resolveFunctionsSourceDir(currentProject.raw),
				".env",
			);
		return resolve(workdirOf(root), targetRel);
	};

	const cleanupFunctionsEnv = (root?: string) => {
		if (options.functionsEnv?.keepOnExit) return;
		if (root) {
			const targetPath = functionsEnvAbsPath(root);
			if (targetPath) {
				const handle = activeFunctionsEnvByPath.get(targetPath);
				if (handle) {
					activeFunctionsEnvByPath.delete(targetPath);
					handle.restore();
				}
				return;
			}
		}
		for (const [path, handle] of activeFunctionsEnvByPath) {
			activeFunctionsEnvByPath.delete(path);
			handle.restore();
		}
	};

	const defaultsForFunctionsSecrets = (
		root: string,
		overrideDefaults: SecretsScopeInput | false | undefined,
	): SecretsScopeInput | false | undefined => {
		const base =
			overrideDefaults !== undefined
				? overrideDefaults
				: stateOf(root)?.configSecrets;
		if (base === false) return false;
		if (base !== undefined) return base;
		const fromFile = readInfisicalProjectId(root);
		return fromFile ? { projectId: fromFile } : undefined;
	};

	return {
		name: "firebase",

		config(config, ctx) {
			const root = ctx?.root ?? findMonorepoRoot();
			lastRoot = root;
			const read = readFirebaseProject(workdirOf(root), configFile);
			const selected = selectEmulators(read.raw, options.emulators);
			const raw = read.raw;

			const projectId =
				options.projectId ??
				read.defaultProject ??
				`demo-${config.projectPrefix}`;
			stateByRoot.set(root, {
				project: read,
				selected,
				resolvedProjectId: projectId,
				configSecrets: config.secrets,
			});
			const base = anchorPort(raw);

			// Every port moves by the offset the app's own port did.
			const offsetOf = (ports: Readonly<Record<string, number>>) =>
				(ports[FIREBASE_APP] ?? base) - base;

			const command = [
				shellQuote(firebaseCli.resolve([workdirOf(root), root])),
				"emulators:start",
				"--config",
				shellQuote(generatedConfigInWorkdir),
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
				captures: {
					firebaseOom: {
						pattern: /java\.lang\.OutOfMemoryError[^\r\n]*/,
						as: "event",
					},
				},
			};

			const userEnv = config.env;

			return {
				...config,
				apps,
				generatedFiles: [
					...(config.generatedFiles ?? []),
					{
						path: normalize(
							join(workdirOption ?? ".", generatedConfigInWorkdir),
						),
						gitignore: true,
						render: (renderCtx) =>
							`${JSON.stringify(
								generatedFirebaseConfig(
									raw,
									selected,
									emulatorPorts(raw, selected, offsetOf(renderCtx.ports)),
									projectId,
								),
								null,
								2,
							)}\n`,
					},
				],
				env: (ports, urls, envCtx): EnvValues => {
					if (!isActiveForProfile(envCtx.activeApps)) {
						return userEnv?.(ports, urls, envCtx) ?? {};
					}
					const unreachable =
						(options.unselectedEmulators ??
							(projectId.startsWith("demo-") ? "unreachable" : "unset")) ===
						"unreachable"
							? unselectedEmulatorEnv(selected)
							: {};
					const env = {
						...unreachable,
						...emulatorEnv(
							selected,
							emulatorPorts(
								raw,
								selected,
								offsetOf(ports as Record<string, number>),
							),
							projectId,
						),
					};

					return {
						...env,
						...(options.webConfigEnv
							? { [options.webConfigEnv]: firebaseWebConfig(projectId) }
							: {}),
						...publicEnvCopies(
							Object.fromEntries(
								FIREBASE_PUBLIC_ENV.map((name) => [name, env[name]]),
							),
							options.publicEnvPrefix,
						),
						...userEnv?.(ports, urls, envCtx),
					};
				},
			} as IntegrationConfig;
		},

		// The hub announces itself in `$TMPDIR/hub-<project id>.json`. With one
		// shared temp dir, two checkouts on the same project id read each
		// other's hub, so each gets its own. Demo projects also isolate Google
		// credentials across `firebase` and sibling apps, optional `javaHeap`
		// adds `-Xmx`, and a broken `JAVA_HOME` is cleared for `firebase`.
		appEnv: (app) => {
			if (!isActiveForProfile(app.activeApps)) return undefined;

			const tmpDir = emulatorTmpDir(app.root);
			const isolate = shouldIsolateCredentials(app.root);

			if (app.name !== FIREBASE_APP) {
				if (!isolate) return undefined;
				return {
					GOOGLE_APPLICATION_CREDENTIALS: "",
					CLOUDSDK_CONFIG: emulatorCloudSdkDir(tmpDir),
				};
			}

			const env: Record<string, string> = {
				TMPDIR: tmpDir,
			};

			const javaToolOptions = mergeJavaToolOptions(
				process.env.JAVA_TOOL_OPTIONS,
				resolvedJavaHeap,
			);
			if (javaToolOptions !== undefined) {
				env.JAVA_TOOL_OPTIONS = javaToolOptions;
			}

			if (isBrokenJavaHome(process.env.JAVA_HOME)) {
				env.JAVA_HOME = "";
			}

			if (isolate) {
				env.GOOGLE_APPLICATION_CREDENTIALS = "";
				env.CLOUDSDK_CONFIG = emulatorCloudSdkDir(tmpDir);
			}

			return env;
		},

		secretScopes: ({ selectedApps, root, defaults }) => {
			if (defaults === false) return [];
			if (
				!options.functionsEnv?.secrets ||
				!selectedApps.includes(FIREBASE_APP)
			) {
				return [];
			}
			const effectiveRoot = root ?? lastRoot;
			const selected = effectiveRoot
				? (stateOf(effectiveRoot)?.selected ??
					selectEmulators(projectOf(effectiveRoot).raw, options.emulators))
				: [];
			if (!selected.includes("functions")) return [];

			const fromFile = effectiveRoot
				? readInfisicalProjectId(effectiveRoot)
				: undefined;
			const scope =
				fromFile && defaults === undefined
					? attachProjectIdIfMissing(options.functionsEnv.secrets, fromFile)
					: options.functionsEnv.secrets;
			return [scope];
		},

		onAppReady: async (app) => {
			if (app.name !== FIREBASE_APP) return;
			const state = stateOf(app.root);
			if (
				!options.pubsubTopics?.length ||
				!state ||
				!state.selected.includes("pubsub")
			) {
				return;
			}

			const base = anchorPort(state.project.raw);
			const offset = (app.ports[FIREBASE_APP] ?? base) - base;
			const ports = emulatorPorts(state.project.raw, state.selected, offset);
			const pubsubPort = ports.port.pubsub;
			const pubsubHost = ports.host.pubsub ?? "127.0.0.1";
			if (pubsubPort === undefined) return;

			await ensurePubsubTopics({
				host: pubsubHost,
				port: pubsubPort,
				projectId: state.resolvedProjectId,
				topics: options.pubsubTopics,
				signal: app.signal,
			});
		},

		hooks: {
			async beforeServers(ctx) {
				if (ctx.selectedApps && !ctx.selectedApps.includes(FIREBASE_APP)) {
					return;
				}
				const dir = emulatorTmpDir(ctx.root);
				mkdirSync(dir, { recursive: true });
				if (shouldIsolateCredentials(ctx.root)) {
					mkdirSync(emulatorCloudSdkDir(dir), { recursive: true });
				}
				removeStaleHubLocators(dir);

				const fnEnv = options.functionsEnv;
				const state = stateOf(ctx.root);
				const selected =
					state?.selected ??
					selectEmulators(projectOf(ctx.root).raw, options.emulators);
				if (!fnEnv || !selected.includes("functions")) return;

				const targetPath = functionsEnvAbsPath(ctx.root);
				if (!targetPath) return;

				const mergedValues: EnvValues = {};
				const secretDefaults = defaultsForFunctionsSecrets(
					ctx.root,
					ctx.secrets,
				);
				if (fnEnv.secrets && secretDefaults !== false) {
					const scopes = resolveScopes(fnEnv.secrets, secretDefaults);
					const layers = await Promise.all(
						scopes.map(async (scope) => {
							try {
								return await loadScopeSecrets(scope, { signal: ctx.signal });
							} catch (error) {
								if (stopsTheRun(error)) throw error;
								warnSecretsOnce(scope, describeSecretsError(error));
								return {};
							}
						}),
					);
					const fetchedSecrets: Record<string, string> = {};
					for (const layer of layers) Object.assign(fetchedSecrets, layer);
					Object.assign(mergedValues, fetchedSecrets);

					const required = requiredSecretKeys(fnEnv.secrets);
					if (required.length > 0) {
						const missing = missingKeys(required, {
							...process.env,
							...fetchedSecrets,
						});
						if (missing.length > 0) {
							throw new Error(
								`Required Firebase functionsEnv secrets are missing: ${missing.join(", ")}. Add them to Infisical or export them in your shell.`,
							);
						}
					}
				}
				if (fnEnv.values) {
					const extra =
						typeof fnEnv.values === "function"
							? fnEnv.values(ctx)
							: fnEnv.values;
					Object.assign(mergedValues, extra);
				}

				const rendered = renderFunctionsEnvFile(mergedValues, {
					exclude: fnEnv.exclude,
					isolateCredentials: shouldIsolateCredentials(ctx.root),
				});
				activeFunctionsEnvByPath.get(targetPath)?.restore();
				const handle = writeFunctionsEnvFile(targetPath, rendered.content, {
					backupDir: projectStateFilePath(
						ctx.root,
						"firebase-functions-env-backup",
					),
				});
				activeFunctionsEnvByPath.set(targetPath, handle);
			},

			async afterServersStop(ctx) {
				cleanupFunctionsEnv(ctx?.root);
			},

			async beforeStop(ctx) {
				cleanupFunctionsEnv(ctx?.root);
			},

			onCapture(event) {
				if (event.app !== FIREBASE_APP || event.name !== "firebaseOom") return;
				const hint = resolvedJavaHeap
					? `Raise firebase({ javaHeap }) above ${resolvedJavaHeap}`
					: 'Set firebase({ javaHeap: "auto" }) in dev.config.ts';
				console.warn(
					formatWarn(
						`Firebase emulator ran out of JVM heap (${event.value}). ${hint}.`,
					),
				);
			},
		},

		bannerHint: (app) => {
			if (app.name !== FIREBASE_APP) return undefined;
			const selected = stateOf(app.root)?.selected ?? [];
			return selected.length > 0 ? selected.join(", ") : undefined;
		},

		get setupChecks() {
			return firebaseChecks({
				project: projectOf,
				workdir: workdirOf,
				emulators: (root) =>
					selectEmulators(projectOf(root).raw, options.emulators),
				dataDir: () =>
					dataDir && normalize(join(workdirOption ?? ".", dataDir)),
				...(options.functionsEnv
					? { functionsEnvPath: (root: string) => functionsEnvRelPath(root) }
					: {}),
				configFile,
				root: lastRoot,
				appName: FIREBASE_APP,
			});
		},

		describe: (ctx) => {
			if (!isActiveForProfile(ctx.activeApps)) return {};
			const state = stateOf(ctx.root);
			const url = (ctx.urls as Record<string, string>)[FIREBASE_APP];
			const rows: Record<string, string> = {};
			if (url && state && uiEnabled(state.project.raw)) {
				rows["Firebase Emulator UI"] = url;
			}
			return rows;
		},

		// Only publish emulator hosts to linked checkouts when this run actually
		// starts or reuses the `firebase` app; a run without it leaves no dead
		// emulator endpoints in `runs.json`.
		exportEnv: (ctx) => {
			const state = stateOf(ctx.root);
			if (!state) return undefined;
			if (!ctx.selectedApps?.includes(FIREBASE_APP)) return undefined;

			const base = anchorPort(state.project.raw);
			const ports = ctx.ports as Record<string, number>;
			const offset = (ports[FIREBASE_APP] ?? base) - base;
			const env = emulatorEnv(
				state.selected,
				emulatorPorts(state.project.raw, state.selected, offset),
				state.resolvedProjectId,
			);
			const isolation: Record<string, string> = shouldIsolateCredentials(
				ctx.root,
			)
				? {
						GOOGLE_APPLICATION_CREDENTIALS: "",
						CLOUDSDK_CONFIG: emulatorCloudSdkDir(emulatorTmpDir(ctx.root)),
					}
				: {};
			return {
				...env,
				...publicEnvCopies(
					Object.fromEntries(
						FIREBASE_PUBLIC_ENV.map((name) => [name, env[name]]),
					),
					options.publicEnvPrefix,
				),
				...isolation,
			};
		},
	};
}
