import { existsSync } from "node:fs";
import { join } from "node:path";
import { childProcessEnv } from "../core/child-env";
import { lookupOnPath } from "../core/tool-binary";
import { isVersionInRange, parseVersion } from "../core/version";

/** Versions the integration is tested against. */
const TESTED_SUPABASE_CLI = { min: "2.0.0", below: "3.0.0" } as const;

/** The project's own CLI first, so every checkout runs its pinned version; then `PATH`. */
function findSupabaseBin(root: string): string | undefined {
	const local = join(root, "node_modules", ".bin", "supabase");
	return existsSync(local) ? local : lookupOnPath("supabase");
}

/**
 * Absolute when it can be: the path is recorded in the run registry for the
 * sweep, which runs it from a different environment.
 */
export function resolveSupabaseBin(root: string): string {
	return findSupabaseBin(root) ?? "supabase";
}

export function isSupabaseInstalled(root: string): boolean {
	return findSupabaseBin(root) !== undefined;
}

export function isTestedSupabaseVersion(version: string): boolean {
	return isVersionInRange(
		version,
		TESTED_SUPABASE_CLI.min,
		TESTED_SUPABASE_CLI.below,
	);
}

/** `supabase --version`, or undefined when the binary cannot run. */
export function supabaseVersion(bin: string, cwd: string): string | undefined {
	try {
		const result = Bun.spawnSync([bin, "--version"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: childProcessEnv(),
			timeout: 15_000,
		});
		if (result.exitCode !== 0) return undefined;
		return parseVersion(result.stdout.toString());
	} catch {
		return undefined;
	}
}
