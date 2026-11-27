import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { childProcessEnv } from "../core/child-env";
import { guardsApp } from "../core/egress-guard/rules";
import { appendToGitignore, isGitIgnored } from "../core/gitignore";
import { detectPackageManager, findLockfile } from "../core/package-manager";
import { lookupOnPath } from "../core/tool-binary";
import { parseVersion } from "../core/version";
import type { CheckOutcome, SetupCheck } from "../types";
import { firebaseCli } from "./cli";
import {
	type FirebaseEmulator,
	missingEmulatorDownloads,
	uiEnabled,
} from "./emulators";
import { FIREBASE_CONFIG_FILE, type FirebaseProject } from "./project";

/** The emulators `firebase-tools` runs on the JVM. */
const JAVA_EMULATORS: readonly FirebaseEmulator[] = [
	"firestore",
	"database",
	"storage",
	"pubsub",
];

/**
 * Where `firebase-tools` keeps the emulators' jars and zips, as it decides:
 * `FIREBASE_EMULATORS_PATH`, else `~/.cache/firebase/emulators`.
 */
function emulatorCacheEntries(env: NodeJS.ProcessEnv): string[] {
	const dir =
		env.FIREBASE_EMULATORS_PATH ||
		join(homedir(), ".cache", "firebase", "emulators");
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Bounds `java -version` so a broken stub (such as macOS's prompt shim) never hangs. */
const JAVA_VERSION_TIMEOUT_MS = 5_000;

/**
 * Parse the major Java version from `java -version` output (or a JDK `release`
 * file's `JAVA_VERSION="..."` line).
 *
 * Handles both legacy `1.8.0_412` → `8` and modern `17.0.12` / `21` / `22-ea`
 * → `17` / `21` / `22`.
 */
export function parseJavaMajorVersion(output: string): number | undefined {
	const quoted = /(?:version\s+|JAVA_VERSION=)"(\d+)(?:\.(\d+))?/i.exec(output);
	const match =
		quoted ?? /\b(?:java|openjdk)\s+(\d+)(?:\.(\d+))?/i.exec(output);
	if (!match) return undefined;

	const first = Number.parseInt(match[1], 10);
	if (first === 1) {
		return match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
	}

	return first;
}

function majorVersionOf(version: string | undefined): number | undefined {
	const parsed = version ? parseVersion(version) : undefined;
	if (!parsed) return undefined;
	return Number.parseInt(parsed.split(".")[0], 10);
}

/**
 * Decide whether the detected Java major version satisfies the installed
 * `firebase-tools` version.
 *
 * Java `< 11` always fails (Firestore/Storage emulators fail on Java 8).
 * Java `>= 21` always passes. Java `11..20` warns on `firebase-tools` 13 (or
 * when the CLI version is unknown) and fails on `firebase-tools` 14+.
 */
export function evaluateJavaVersion(
	javaMajor: number | undefined,
	firebaseVersion: string | undefined,
): CheckOutcome {
	if (javaMajor === undefined) {
		return {
			ok: false,
			detail:
				"Could not determine Java version from `java -version`. Install JDK 21 or newer and put its bin directory on PATH.",
		};
	}

	if (javaMajor < 11) {
		return {
			ok: false,
			detail: `Java ${javaMajor} is installed, which is too old for the Firestore, Realtime Database and Storage emulators (require JDK 11+, and JDK 21+ on firebase-tools 14+). Install JDK 21 or newer and put its bin directory on PATH.`,
		};
	}

	if (javaMajor >= 21) return true;

	const cliMajor = majorVersionOf(firebaseVersion);
	if (cliMajor !== undefined && cliMajor >= 14) {
		return {
			ok: false,
			detail: `Java ${javaMajor} is installed, but firebase-tools ${firebaseVersion} requires JDK 21 or newer for the Firestore, Realtime Database and Storage emulators. Install JDK 21+ and put its bin directory on PATH.`,
		};
	}

	if (cliMajor === 13) {
		return {
			ok: false,
			severity: "warning",
			detail: `Java ${javaMajor} is installed; firebase-tools ${firebaseVersion} supports JDK 11+, but upgrading to JDK 21+ is required for firebase-tools 14+.`,
		};
	}

	return {
		ok: false,
		severity: "warning",
		detail: `Java ${javaMajor} is installed; firebase-tools 14+ requires JDK 21 or newer for the Firestore, Realtime Database and Storage emulators. Upgrade to JDK 21+ and put its bin directory on PATH.`,
	};
}

/**
 * Read `JAVA_VERSION="..."` from the JDK's `release` file beside `javaBin`
 * without spawning a JVM. Returns `undefined` for shims or JDKs without one.
 */
function readJdkReleaseMajor(javaBin: string): number | undefined {
	try {
		const releasePath = join(
			dirname(dirname(realpathSync(javaBin))),
			"release",
		);
		if (!existsSync(releasePath)) return undefined;
		return parseJavaMajorVersion(readFileSync(releasePath, "utf8"));
	} catch {
		// Unresolvable symlink or unreadable release file; fall through to `java -version`.
		return undefined;
	}
}

/** Determine the Java major version, preferring the JDK `release` file over spawning `java -version`. */
async function detectJavaMajorVersion(
	javaBin: string,
	env: NodeJS.ProcessEnv,
): Promise<number | undefined> {
	const fromRelease = readJdkReleaseMajor(javaBin);
	if (fromRelease !== undefined) return fromRelease;

	try {
		const proc = Bun.spawn([javaBin, "-version"], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env,
			signal: AbortSignal.timeout(JAVA_VERSION_TIMEOUT_MS),
			killSignal: "SIGKILL",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		if (exitCode !== 0) return undefined;
		return parseJavaMajorVersion(`${stdout}\n${stderr}`);
	} catch {
		return undefined;
	}
}

/**
 * Read `firebase-tools`'s installed version from `package.json` without
 * spawning the Node CLI on the fast startup path.
 */
function readFirebaseToolsVersion(dirs: readonly string[]): string | undefined {
	for (const dir of dirs) {
		const pkgPath = join(dir, "node_modules", "firebase-tools", "package.json");
		const version = readPackageVersion(pkgPath, "firebase-tools");
		if (version) return version;
	}

	const bin = firebaseCli.resolve(dirs);
	if (existsSync(bin)) {
		try {
			let dir = dirname(realpathSync(bin));
			for (let depth = 0; depth < 6; depth += 1) {
				const version = readPackageVersion(
					join(dir, "package.json"),
					"firebase-tools",
				);
				if (version) return version;
				const parent = dirname(dir);
				if (parent === dir) break;
				dir = parent;
			}
		} catch {
			// Unresolvable symlink: fall back to undefined without spawning Node.
		}
	}

	return undefined;
}

function readPackageVersion(
	pkgPath: string,
	expectedName: string,
): string | undefined {
	if (!existsSync(pkgPath)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			name?: unknown;
			version?: unknown;
		};
		if (parsed.name === expectedName && typeof parsed.version === "string") {
			return parseVersion(parsed.version);
		}
	} catch {
		// Unreadable package.json: try the next source.
	}
	return undefined;
}

export function firebaseChecks(state: {
	project: (root: string) => FirebaseProject;
	workdir: (root: string) => string;
	emulators: (root: string) => readonly FirebaseEmulator[];
	/** The data directory, relative to the root; undefined without persistence. */
	dataDir: (root: string) => string | undefined;
	/** Optional `functionsEnv` `.env` path relative to the root, checked for `.gitignore`. */
	functionsEnvPath?: (root: string) => string | undefined;
	/** The Firebase config file name relative to workdir. Default: `firebase.json`. */
	configFile?: string;
	/** Checkout root (when known at config time) for package-manager-aware install hints. */
	root?: string;
	/** App key for checking whether an active profile excluded Firebase. */
	appName?: string;
}): SetupCheck[] {
	const configFile = state.configFile ?? FIREBASE_CONFIG_FILE;
	const pmDir = (() => {
		if (!state.root) return undefined;
		const workdir = state.workdir(state.root);
		return findLockfile(workdir) !== undefined ? workdir : state.root;
	})();
	const installFix = pmDir
		? detectPackageManager(pmDir).addDevCommand("firebase-tools")
		: "bun add -d firebase-tools";
	// Where the CLI is installed, so the package manager finds its binary.
	const cliDir = (root: string) => {
		const workdir = state.workdir(root);
		return findLockfile(workdir) !== undefined ? workdir : root;
	};
	const missingDownloads = (root: string) =>
		missingEmulatorDownloads(
			state.emulators(root),
			uiEnabled(state.project(root).raw),
			emulatorCacheEntries(process.env),
		);
	const setupArgs = (name: string) => [`setup:emulators:${name}`];
	const whenActive =
		(fn: SetupCheck["check"]): SetupCheck["check"] =>
		(ctx) => {
			if (
				state.appName !== undefined &&
				ctx.activeApps !== undefined &&
				!ctx.activeApps.has(state.appName)
			) {
				return true;
			}
			return fn(ctx);
		};

	const checks: SetupCheck[] = [
		{
			name: "Firebase CLI is installed",
			check: whenActive(({ root }) =>
				firebaseCli.installed([state.workdir(root), root]),
			),
			fix: installFix,
		},
		{
			name: `${configFile} exists`,
			check: whenActive(({ root }) => {
				const project = state.project(root);
				if (project.error) {
					return {
						ok: false,
						detail: `${relative(root, project.path)}: ${project.error}`,
					};
				}

				if (!project.exists) {
					return {
						ok: false,
						detail: `No ${relative(root, project.path)}; run \`firebase init emulators\``,
					};
				}

				return (
					state.emulators(root).length > 0 || {
						ok: false,
						detail: `${relative(root, project.path)} configures no emulator; run \`firebase init emulators\``,
					}
				);
			}),
		},
		{
			name: "Java is installed for the Firebase emulators",
			check: whenActive(async ({ root }) => {
				const needsJava = state
					.emulators(root)
					.some((name) => JAVA_EMULATORS.includes(name));
				if (!needsJava) return true;

				const env = childProcessEnv();
				const javaBin = lookupOnPath("java", env);
				if (!javaBin) {
					return {
						ok: false,
						detail:
							"Firestore, Realtime Database, Pub/Sub and Storage emulators need a JDK 21 or newer on PATH",
					};
				}

				const javaMajor = await detectJavaMajorVersion(javaBin, env);
				if (javaMajor !== undefined && (javaMajor < 11 || javaMajor >= 21)) {
					return evaluateJavaVersion(javaMajor, undefined);
				}

				const cliVersion =
					javaMajor === undefined
						? undefined
						: readFirebaseToolsVersion([state.workdir(root), root]);
				return evaluateJavaVersion(javaMajor, cliVersion);
			}),
		},
		{
			name: "Firebase emulator downloads are cached",
			check: whenActive(({ root, egressGuard }) => {
				const missing = missingDownloads(root);
				if (missing.length === 0) return true;

				const manager = detectPackageManager(cliDir(root));
				const commands = missing
					.map((download) =>
						manager.execDisplay("firebase", setupArgs(download.name)),
					)
					.join(" && ");
				// Behind a blocking guard the CLI's own first download is refused.
				const guarded =
					egressGuard?.enabled &&
					egressGuard.mode === "block" &&
					state.appName !== undefined &&
					guardsApp(egressGuard, state.appName);
				const why = guarded
					? "the egress guard would refuse the CLI's first download"
					: "the first start downloads them";
				return {
					ok: false,
					...(guarded ? {} : { severity: "warning" as const }),
					detail: `${missing.map((download) => download.name).join(", ")} not downloaded yet (${why}); run \`${commands}\``,
				};
			}),
			fix: ({ root }) => {
				const dir = cliDir(root);
				const manager = detectPackageManager(dir);
				for (const download of missingDownloads(root)) {
					const args = setupArgs(download.name);
					const result = Bun.spawnSync(manager.execArgs("firebase", args), {
						cwd: dir,
						stdin: "ignore",
						stdout: "inherit",
						stderr: "inherit",
						env: childProcessEnv(),
					});
					if (result.exitCode !== 0) {
						const command = manager.execDisplay("firebase", args);
						throw new Error(
							`\`${command}\` failed in ${dir} (exit ${result.exitCode}); its output is above.`,
						);
					}
				}
			},
			fixDescription:
				"run `firebase setup:emulators:<name>` for each missing download, through the project's package manager",
		},
		{
			name: "Firebase emulator data is gitignored",
			severity: "warning",
			fast: false,
			check: whenActive(({ root }) => {
				const dir = state.dataDir(root);
				if (!dir) return true;

				return (
					isGitIgnored(root, dir) || {
						ok: false,
						detail: `${dir} is not gitignored`,
					}
				);
			}),
			fix: ({ root }) => {
				const dir = state.dataDir(root);
				if (dir) appendToGitignore(root, [`/${dir}`]);
			},
			fixDescription: "add it to .gitignore",
		},
		{
			name: "Firebase CLI version is tested",
			fast: false,
			severity: "warning",
			check: whenActive(({ root }) => {
				const dirs = [state.workdir(root), root];
				// Prefer package.json metadata over spawning the Node CLI (~200ms).
				const version =
					readFirebaseToolsVersion(dirs) ??
					firebaseCli.version(firebaseCli.resolve(dirs), root);
				if (!version) {
					return { ok: false, detail: "`firebase --version` failed" };
				}

				return (
					firebaseCli.isTested(version) || {
						ok: false,
						detail: `Firebase CLI ${version} is outside the tested 13.x–15.x range`,
					}
				);
			}),
		},
	];

	if (state.functionsEnvPath) {
		const resolvePath = state.functionsEnvPath;
		checks.push({
			name: "Firebase functions .env is gitignored",
			severity: "warning",
			fast: false,
			check: whenActive(({ root }) => {
				const rel = resolvePath(root);
				if (!rel) return true;
				return (
					isGitIgnored(root, rel) || {
						ok: false,
						detail: `${rel} is not gitignored (firebase functionsEnv writes secrets there)`,
					}
				);
			}),
			fix: ({ root }) => {
				const rel = resolvePath(root);
				if (rel) appendToGitignore(root, [`/${rel}`]);
			},
			fixDescription: "add it to .gitignore",
		});
	}

	return checks;
}
