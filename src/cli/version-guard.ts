import {
	existsSync,
	readFileSync,
	realpathSync,
	type Stats,
	statSync,
	writeSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { isRecord, typedSwitch } from "hanzio";
import {
	isInstallingCheckout,
	REEXEC_ENV,
	reexecedFrom,
} from "../core/runtime-flags";
import { buncargoPackage, findBuncargoPackage } from "../core/version";
import { CliError } from "./errors";
import { lockfileHash, readInstallStamp } from "./install-stamp";

/**
 * Run the project's own buncargo, never whichever one is on `PATH`.
 *
 * `bunx buncargo` in a checkout without `node_modules/.bin` falls through to a
 * global install. An old one fails on new commands ("Unknown command: files")
 * or, worse, runs `dev` and silently skips what the project's version does.
 * So the CLI looks for the project's install first, the way module resolution
 * would, and hands over to it when the versions differ.
 *
 * Before that, a checkout whose `node_modules` is missing or older than its
 * `bun.lock` installs itself (`checkout-install.ts`): a fresh worktree or a
 * branch switch used to stop every command on "Run `bun install`".
 *
 * It reads a few files and forks nothing; a matching version and an installed
 * checkout cost nothing more.
 */

export type VersionGuard =
	| { kind: "run" }
	| { kind: "reexec"; entry: string; version: string }
	| { kind: "not-installed"; packageJson: string; reason: string };

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
	const bin = pkg.bin as Record<string, unknown> | undefined;
	return typeof bin?.buncargo === "string" ? bin.buncargo : undefined;
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
 * Whether the dependencies in `dir` (which holds `bun.lock`) predate it: the
 * lockfile's hash against the one buncargo last installed from.
 *
 * Without that stamp, the `node_modules` directory's own time stands in: a
 * checkout installed by hand is not reinstalled until `bun.lock` changes after
 * it. Stats only, unless a stamp exists to compare the lockfile against.
 */
export function installNeed(dir: string): InstallNeed | undefined {
	const lock = statOrUndefined(join(dir, "bun.lock"));
	if (!lock) return undefined;
	const modules = statOrUndefined(join(dir, "node_modules"));
	if (!modules)
		return { dir, missing: true, reason: "node_modules is missing" };

	const stamp = readInstallStamp(dir);
	const stale =
		stamp === undefined
			? lock.mtimeMs > modules.mtimeMs
			: stamp !== lockfileHash(dir);
	return stale
		? {
				dir,
				missing: false,
				reason: "bun.lock changed since node_modules was installed",
			}
		: undefined;
}

/**
 * The commands that run the project's own code, so stale dependencies give
 * them phantom errors. Everything else (`stop`, `status`, `logs`, BuncargoBar's
 * buttons) never reinstalls under a running run, and never fails on an
 * install it did not need.
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
	"predeploy",
	"setup",
]);

/** Whether `args` (after `buncargo`) is worth bringing stale dependencies up to date for. */
export function refreshesStaleInstall(args: readonly string[]): boolean {
	const [command = ""] = args;
	const asksForHelp = args.includes("--help") || args.includes("-h");
	return (
		PROJECT_COMMANDS.has(command) && !asksForHelp && !args.includes("--down")
	);
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
	for (let dir = cwd; ; dir = dirname(dir)) {
		const project = readPackageJson(join(dir, "package.json"));
		if (project && project.name !== "buncargo" && listsBuncargo(project))
			declared = true;
		if (project && existsSync(join(dir, "bun.lock"))) {
			const need = declared ? installNeed(dir) : undefined;
			return need?.missing || refreshesStaleInstall(args) ? need : undefined;
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
	for (let dir = cwd; ; dir = dirname(dir)) {
		const installed = join(dir, "node_modules", "buncargo");
		const pkg = readPackageJson(join(installed, "package.json"));
		if (pkg) {
			if (
				pkg.version === running.version ||
				realpathSync(installed) === realpathSync(running.root)
			)
				return { kind: "run" };
			const bin = binEntry(pkg);
			const entry = bin ? join(installed, bin) : undefined;
			if (!entry || !existsSync(entry))
				return {
					kind: "not-installed",
					packageJson: join(installed, "package.json"),
					reason: `its CLI (${bin ?? "bin"}) is missing`,
				};
			return { kind: "reexec", entry, version: String(pkg.version) };
		}

		const projectPackage = join(dir, "package.json");
		const project = readPackageJson(projectPackage);
		if (project && project.name !== "buncargo" && listsBuncargo(project))
			declared ??= projectPackage;

		// A project's dependencies live inside its repository.
		if (existsSync(join(dir, ".git")) || dirname(dir) === dir) break;
	}
	return declared
		? { kind: "not-installed", packageJson: declared, reason: "not installed" }
		: { kind: "run" };
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
		if (onDisk && onDisk !== own.version)
			handOver(process.argv[1], onDisk, own.version);
	}

	const decision = decideVersionGuard(process.cwd(), {
		version: own.version,
		root,
	});

	typedSwitch(decision, "kind", {
		run: () => {},
		"not-installed": (notInstalled) => {
			const where = relative(process.cwd(), notInstalled.packageJson);
			throw new CliError(
				`This project's buncargo (${where}) is ${notInstalled.reason}, so buncargo ${own.version} from ${root} will not run in its place.`,
				["Run `bun install`, then run the command again."],
			);
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
