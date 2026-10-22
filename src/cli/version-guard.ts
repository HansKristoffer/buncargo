import { existsSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { isRecord, typedSwitch } from "hanzio";
import { REEXEC_ENV, reexecedFrom } from "../core/runtime-flags";
import { buncargoPackage } from "../core/version";
import { CliError } from "./errors";

/**
 * Run the project's own buncargo, never whichever one is on `PATH`.
 *
 * `bunx buncargo` in a checkout without `node_modules/.bin` falls through to a
 * global install. An old one fails on new commands ("Unknown command: files")
 * or, worse, runs `dev` and silently skips what the project's version does.
 * So the CLI looks for the project's install first, the way module resolution
 * would, and hands over to it when the versions differ.
 *
 * It reads a few files and forks nothing; a matching version costs nothing
 * more.
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
 * Hand over to the project's buncargo, or stop when it is listed but not
 * installed. Returns when this CLI is the one to run.
 *
 * A CLI run from a source checkout (`bun src/cli/bin.ts`) is never
 * replaced: that is someone testing the source on purpose.
 */
export function guardVersion(fromSource: boolean): void {
	const handedOver = reexecedFrom();
	// Not inherited by the apps and tools this run starts.
	delete process.env[REEXEC_ENV];
	if (handedOver || fromSource) return;

	const own = buncargoPackage();
	if (!own) return;
	const root = own.dir;
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
		reexec: (reexec) => {
			// Straight to fd 2: execve drops whatever Bun still has buffered.
			writeSync(
				2,
				`buncargo ${own.version} → this project's buncargo ${reexec.version}\n`,
			);
			process.execve?.(
				process.execPath,
				[process.execPath, reexec.entry, ...process.argv.slice(2)],
				{ ...process.env, [REEXEC_ENV]: own.version },
			);
			throw new CliError(
				`Could not start this project's buncargo ${reexec.version} (${reexec.entry}).`,
			);
		},
	});
}
