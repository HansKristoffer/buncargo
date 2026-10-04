import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookupOnPath } from "../core/tool-binary";

/** Versions the integration is tested against. */
const TESTED_SUPABASE_CLI = { min: [2, 0, 0], below: [3, 0, 0] } as const;

/**
 * The project's own CLI first, so every checkout runs its pinned version;
 * then `PATH`. Absolute when it can be: the path is recorded in the run
 * registry for the sweep, which runs it from a different environment.
 */
export function resolveSupabaseBin(root: string): string {
	const local = join(root, "node_modules", ".bin", "supabase");
	if (existsSync(local)) return local;
	return lookupOnPath("supabase") ?? "supabase";
}

export function isSupabaseInstalled(root: string): boolean {
	return (
		existsSync(join(root, "node_modules", ".bin", "supabase")) ||
		lookupOnPath("supabase") !== undefined
	);
}

export function parseSupabaseVersion(
	text: string,
): [number, number, number] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match
		? [Number(match[1]), Number(match[2]), Number(match[3])]
		: undefined;
}

export function isTestedSupabaseVersion(version: readonly number[]): boolean {
	const compare = (a: readonly number[], b: readonly number[]) => {
		for (let index = 0; index < 3; index++) {
			const diff = (a[index] ?? 0) - (b[index] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	};
	return (
		compare(version, TESTED_SUPABASE_CLI.min) >= 0 &&
		compare(version, TESTED_SUPABASE_CLI.below) < 0
	);
}

/** `supabase --version`, or undefined when the binary cannot run. */
export function supabaseVersion(bin: string, cwd: string): string | undefined {
	try {
		const result = Bun.spawnSync([bin, "--version"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: process.env,
			timeout: 15_000,
		});
		if (result.exitCode !== 0) return undefined;
		return parseSupabaseVersion(result.stdout.toString())?.join(".");
	} catch {
		return undefined;
	}
}
