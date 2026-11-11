import { existsSync } from "node:fs";
import { join } from "node:path";
import { childProcessEnv } from "./child-env";
import { lookupOnPath } from "./tool-binary";
import { isVersionInRange, parseVersion } from "./version";

/**
 * The CLI an integration drives (`shopify`, `supabase`, `firebase`): which
 * binary, which version, and whether that version is one the integration is
 * tested against.
 */
export interface CliTool {
	/**
	 * The binary to run: the first `node_modules/.bin/<name>` in `dirs`, so
	 * every checkout runs its pinned version, then `PATH`, then the bare name.
	 * Absolute when it can be: the run registry records it for the sweep, which
	 * runs it from a different environment.
	 */
	resolve(dirs: readonly string[]): string;
	/** Whether {@link resolve} finds a binary rather than falling back to the bare name. */
	installed(dirs: readonly string[]): boolean;
	/** The version `bin` reports, or undefined when it cannot run. */
	version(bin: string, cwd: string): string | undefined;
	/** Whether `version` is in the tested range. */
	isTested(version: string): boolean;
	/** The environment every run of this CLI gets. */
	env(): NodeJS.ProcessEnv;
}

/**
 * Bounds a version probe nobody watches. A Node CLI's cold start on a loaded
 * machine (Firebase's is the slowest) stays well inside it.
 */
const VERSION_TIMEOUT_MS = 30_000;

export function cliTool(options: {
	name: string;
	/** Arguments that print the version: `["--version"]`, or `["version"]`. */
	versionArgs: readonly string[];
	/** Versions the integration is tested against: at least `min`, below `below`. */
	tested: { readonly min: string; readonly below: string };
	/**
	 * Every run's environment. Passed explicitly: Bun's default is the
	 * environment this process started with, which misses whatever the config
	 * set since. Default: `childProcessEnv()`.
	 */
	env?: () => NodeJS.ProcessEnv;
}): CliTool {
	const { name, versionArgs, tested } = options;
	const env = options.env ?? childProcessEnv;
	const find = (dirs: readonly string[]) => {
		for (const dir of dirs) {
			const local = join(dir, "node_modules", ".bin", name);
			if (existsSync(local)) return local;
		}
		return lookupOnPath(name, env());
	};
	return {
		resolve: (dirs) => find(dirs) ?? name,
		installed: (dirs) => find(dirs) !== undefined,
		version(bin, cwd) {
			try {
				const result = Bun.spawnSync([bin, ...versionArgs], {
					cwd,
					stdout: "pipe",
					stderr: "ignore",
					env: env(),
					timeout: VERSION_TIMEOUT_MS,
				});
				if (result.exitCode !== 0) return undefined;
				return parseVersion(result.stdout.toString());
			} catch {
				return undefined;
			}
		},
		isTested: (version) => isVersionInRange(version, tested.min, tested.below),
		env,
	};
}

/**
 * Each of `values` again under every prefix, for browser code that only sees
 * prefixed variables (`VITE_`, `NEXT_PUBLIC_`, `EXPO_PUBLIC_`).
 */
export function publicEnvCopies(
	values: Readonly<Record<string, string | undefined>>,
	prefix: string | readonly string[] | undefined,
): Record<string, string> {
	const prefixes = typeof prefix === "string" ? [prefix] : (prefix ?? []);
	return Object.fromEntries(
		prefixes.flatMap((each) =>
			Object.entries(values).flatMap(([name, value]) =>
				value === undefined ? [] : [[`${each}${name}`, value]],
			),
		),
	);
}
