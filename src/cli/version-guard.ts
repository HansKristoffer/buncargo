import {
	existsSync,
	readFileSync,
	realpathSync,
	type Stats,
	statSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { isRecord, typedSwitch } from "hanzio";
import { detectPackageManager, findLockfile } from "../core/package-manager";
import {
	isInstallingCheckout,
	REEXEC_ENV,
	reexecedFrom,
} from "../core/runtime-flags";
import { buncargoPackage, findBuncargoPackage } from "../core/version";
import { CliError } from "./errors";
import { readInstallStamp, stampMatchesLockfile } from "./install-stamp";

// Run the project's own buncargo, never whichever one is on `PATH`.
//
// `bunx buncargo` in a checkout without `node_modules/.bin` falls through to a
// global install. An old one fails on new commands ("Unknown command: files")
// or, worse, runs `dev` and silently skips what the project's version does.
// So the CLI looks for the project's install first, the way module resolution
// would, and hands over to it when the versions differ.
//
// Before that, a checkout whose `node_modules` is missing or older than its
// `bun.lock` installs itself (`checkout-install.ts`): a fresh worktree or a
// branch switch used to stop every command on "Run `bun install`".
//
// It reads a few files and forks nothing; a matching version and an installed
// checkout cost nothing more.

export type VersionGuard =
	| { kind: "run" }
	| { kind: "reexec"; entry: string; version: string }
	| {
			kind: "not-installed";
			packageJson: string;
			reason: string;
			/** The workspace root that installs it: the nearest directory with a lockfile. */
			lockfileDir?: string;
	  };

interface PackageJson {
	name?: unknown;
	version?: unknown;
	bin?: unknown;
	dependencies?: unknown;
	devDependencies?: unknown;
	optionalDependencies?: unknown;
}

function readPackageJson(path: string): PackageJson | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
	} catch {
		return undefined;
	}
}

function listsBuncargo(pkg: PackageJson): boolean {
	return [pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some(
		(deps) => isRecord(deps) && "buncargo" in deps,
	);
}

function binEntry(pkg: PackageJson): string | undefined {
	if (typeof pkg.bin === "string") return pkg.bin;
	if (isRecord(pkg.bin) && typeof pkg.bin.buncargo === "string") {
		return pkg.bin.buncargo;
	}
	return undefined;
}

/** A checkout whose dependencies `bun install` has to bring up to date first. */
export interface InstallNeed {
	/** The directory holding `bun.lock`: the workspace root. */
	dir: string;
	/** No `node_modules` at all, rather than one installed from another lockfile. */
	missing: boolean;
	reason: string;
}

function statOrUndefined(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

/**
 * Whether the dependencies in `dir` (which holds a lockfile) predate it: the
 * lockfile's hash against the one buncargo last installed from.
 *
 * Without that stamp, the `node_modules` directory's own time stands in: a
 * checkout installed by hand is not reinstalled until the lockfile changes
 * after it. Stats only, unless a stamp exists to compare the lockfile against.
 */
export function installNeed(
	dir: string,
	options: {
		checkStale?: boolean;
		lockfile?: { path: string; name: string };
	} = {},
): InstallNeed | undefined {
	const found = options.lockfile ?? findLockfile(dir);
	const lock = found ? statOrUndefined(found.path) : undefined;
	if (!found || !lock) return undefined;

	const modules = statOrUndefined(join(dir, "node_modules"));
	if (!modules) {
		return { dir, missing: true, reason: "node_modules is missing" };
	}

	if (options.checkStale === false) return undefined;

	const stamp = readInstallStamp(dir);
	const stale =
		stamp === undefined
			? lock.mtimeMs > modules.mtimeMs
			: !stampMatchesLockfile(stamp, found.path, lock);
	if (!stale) return undefined;

	return {
		dir,
		missing: false,
		reason: `${found.name} changed since node_modules was installed`,
	};
}

/**
 * The commands that run the project's own code, so stale dependencies give
 * them phantom errors. Everything else (`stop`, `status`, `logs`, BuncargoBar's
 * buttons) never reinstalls under a running run, and never fails on an
 * install it did not need. Not `predeploy`: a deploy image's install layer
 * comes from a cache older than its `bun.lock`, and a deploy installs nothing.
 */
const PROJECT_COMMANDS = new Set([
	"dev",
	"run",
	"exec",
	"slot",
	"prisma",
	"build",
	"generate",
	"typecheck",
	"check",
	"ci",
	"setup",
]);

/** Whether `args` (after `buncargo`) is worth bringing stale dependencies up to date for. */
export function refreshesStaleInstall(args: readonly string[]): boolean {
	const [command = ""] = args;
	const asksForHelp = args.includes("--help") || args.includes("-h");
	const tearsDown = args.includes("--down");
	return PROJECT_COMMANDS.has(command) && !asksForHelp && !tearsDown;
}

/**
 * The install a buncargo project needs before `args` runs: from `cwd` up to
 * the repository root, the first directory with a `bun.lock`, when a
 * `package.json` on the way lists buncargo. Anything else is not buncargo's to
 * install. Missing dependencies install for every command, since no command
 * of the project's buncargo runs without them; stale ones only for
 * {@link refreshesStaleInstall}.
 */
export function decideInstall(
	cwd: string,
	args: readonly string[],
): InstallNeed | undefined {
	let declared = false;
	const checkStale = refreshesStaleInstall(args);

	for (let dir = cwd; ; dir = dirname(dir)) {
		const project = readPackageJson(join(dir, "package.json"));

		// buncargo's own repository lists itself; that is not a project using it.
		if (project && project.name !== "buncargo" && listsBuncargo(project)) {
			declared = true;
		}

		const lockfile = project ? findLockfile(dir) : undefined;
		if (lockfile) {
			return declared ? installNeed(dir, { checkStale, lockfile }) : undefined;
		}

		if (existsSync(join(dir, ".git")) || dirname(dir) === dir) return undefined;
	}
}

/**
 * What to do, from `cwd` up to the repository root: the first
 * `node_modules/buncargo` decides, and a `package.json` that lists buncargo
 * with none installed is an error.
 */
export function decideVersionGuard(
	cwd: string,
	running: { version: string; root: string },
): VersionGuard {
	let declared: string | undefined;
	let lockfileDir: string | undefined;

	for (let dir = cwd; ; dir = dirname(dir)) {
		const installed = join(dir, "node_modules", "buncargo");
		const pkg = readPackageJson(join(installed, "package.json"));

		if (pkg) {
			const isRunningCopy =
				pkg.version === running.version ||
				realpathSync(installed) === realpathSync(running.root);
			if (isRunningCopy) return { kind: "run" };

			const bin = binEntry(pkg);
			const entry = bin ? join(installed, bin) : undefined;
			if (!entry || !existsSync(entry)) {
				return {
					kind: "not-installed",
					packageJson: join(installed, "package.json"),
					reason: `its CLI (${bin ?? "bin"}) is missing`,
					...(findLockfile(dir) ? { lockfileDir: dir } : {}),
				};
			}

			return { kind: "reexec", entry, version: String(pkg.version) };
		}

		const projectPackage = join(dir, "package.json");
		const project = readPackageJson(projectPackage);
		if (project && project.name !== "buncargo" && listsBuncargo(project)) {
			declared ??= projectPackage;
		}
		if (declared && findLockfile(dir)) lockfileDir ??= dir;

		// A project's dependencies live inside its repository.
		if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
	}

	return declared
		? {
				kind: "not-installed",
				packageJson: declared,
				reason: "not installed",
				...(lockfileDir ? { lockfileDir } : {}),
			}
		: { kind: "run" };
}

/**
 * The error for a project buncargo that is not installed, with the install
 * command of the package manager that installs it: the workspace root's,
 * not a sub-package's.
 */
export function notInstalledError(
	notInstalled: Extract<VersionGuard, { kind: "not-installed" }>,
	running: { version: string; root: string },
	cwd: string,
): CliError {
	const where = relative(cwd, notInstalled.packageJson);
	const pkgDir = dirname(notInstalled.packageJson);
	const checkoutDir =
		basename(pkgDir) === "buncargo" &&
		basename(dirname(pkgDir)) === "node_modules"
			? dirname(dirname(pkgDir))
			: pkgDir;
	const manager = detectPackageManager(notInstalled.lockfileDir ?? checkoutDir);
	const message = `This project's buncargo (${where}) is ${notInstalled.reason}, so buncargo ${running.version} from ${running.root} will not run in its place.`;
	return new CliError(message, [
		`Run \`${manager.installCommand}\`, then run the command again.`,
	]);
}

/**
 * Install a checkout that needs it, then hand over to the project's buncargo,
 * or stop when it is listed but not installed. Returns when this CLI is the
 * one to run.
 *
 * A CLI run from a source checkout (`bun src/cli/bin.ts`) is never
 * replaced: that is someone testing the source on purpose. Neither installs:
 * a hand-over already ran this, and an install's own postinstall must not
 * start a second one.
 */
export async function guardVersion(fromSource: boolean): Promise<void> {
	const handedOver = reexecedFrom();

	// Not inherited by the apps and tools this run starts.
	delete process.env[REEXEC_ENV];
	if (handedOver || fromSource) return;

	const own = buncargoPackage();
	if (!own) return;
	const root = own.dir;

	const install = isInstallingCheckout()
		? undefined
		: decideInstall(process.cwd(), process.argv.slice(2));

	if (install) {
		(await import("./checkout-install")).installCheckout(install);

		// The install may have replaced the very package this process runs
		// from; its remaining modules load lazily, so start over on the new one.
		const onDisk = findBuncargoPackage(root)?.version;
		if (onDisk && onDisk !== own.version) {
			handOver(process.argv[1], onDisk, own.version);
		}
	}

	const running = { version: own.version, root };
	const cwd = process.cwd();
	let decision = decideVersionGuard(cwd, running);

	// Installed, but without buncargo (removed, or added to the lockfile since):
	// before a command that runs the project, install with the project's
	// package manager and hand over as below. `stop` and `status` never install.
	const missing = decision.kind === "not-installed" ? decision : undefined;
	const installsMissing =
		!isInstallingCheckout() && refreshesStaleInstall(process.argv.slice(2));
	if (missing?.lockfileDir && installsMissing) {
		(await import("./checkout-install")).installCheckout(
			{
				dir: missing.lockfileDir,
				missing: false,
				reason: `buncargo is ${missing.reason}`,
			},
			() => decideVersionGuard(cwd, running).kind === "not-installed",
		);
		decision = decideVersionGuard(cwd, running);
	}

	typedSwitch(decision, "kind", {
		run: () => {},
		"not-installed": (notInstalled) => {
			throw notInstalledError(notInstalled, running, cwd);
		},
		reexec: (reexec) => handOver(reexec.entry, reexec.version, own.version),
	});
}

/** Become `entry` with the same arguments, pid and stdio. */
function handOver(entry: string, version: string, from: string): never {
	// Straight to fd 2: execve drops whatever Bun still has buffered.
	writeSync(2, `buncargo ${from} → this project's buncargo ${version}\n`);

	process.execve?.(
		process.execPath,
		[process.execPath, entry, ...process.argv.slice(2)],
		{ ...process.env, [REEXEC_ENV]: from },
	);
	throw new CliError(
		`Could not start this project's buncargo ${version} (${entry}).`,
	);
}
