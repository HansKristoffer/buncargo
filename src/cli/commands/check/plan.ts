import { existsSync } from "node:fs";
import { join } from "node:path";
import { chunkArray } from "hanzio";
import { isRootWideFile } from "../../../typecheck/changed";
import type { CheckGateConfig } from "../../../types";

export type CheckMode = "changed" | "staged" | "all";

// Chunked so a large change never hits the argument-length limit.
export const FILE_CHUNK = 200;

/**
 * The `bun fmt` runs for `check.format`: write the changed files, check the
 * staged ones, check the whole repo with `--all`. `files` are the ones that
 * still exist. `--no-script` keeps a repo `fmt` script from running instead;
 * the ignore flags let a list hold files bun fmt cannot format.
 */
export function formatCommands(
	format: true | readonly string[],
	files: readonly string[],
	mode: CheckMode,
): { name: string; command: string[] }[] {
	const globs = format === true ? [] : format;
	const flags = [
		"bun",
		"fmt",
		"--no-script",
		...(mode === "changed" ? [] : ["--check"]),
		"--ignore-unknown",
		"--no-error-on-unmatched-pattern",
	];
	const label = mode === "changed" ? "bun fmt" : "bun fmt --check";
	if (mode === "all") return [{ name: label, command: [...flags, ...globs] }];
	const matchers = globs.map((glob) => new Bun.Glob(glob));
	const selected = files.filter(
		(file) =>
			matchers.length === 0 || matchers.some((glob) => glob.match(file)),
	);
	return chunkArray(selected, FILE_CHUNK).map((chunk) => ({
		name: `${label} (${chunk.length} files)`,
		command: [...flags, ...chunk],
	}));
}

/**
 * Whether a step scoped to `patterns` applies to this change. A root-wide
 * file (manifest, lockfile, tsconfig, dev config) touches everything, as it
 * does for `typecheck --changed`.
 */
export function touches(
	files: readonly string[],
	patterns: readonly string[],
	mode: CheckMode,
): boolean {
	if (mode === "all") return true;
	const globs = patterns.map((pattern) => new Bun.Glob(pattern));
	return files.some(
		(file) => isRootWideFile(file) || globs.some((glob) => glob.match(file)),
	);
}

/** The gates this change selects, in config order. */
export function selectGates(
	gates: readonly CheckGateConfig[],
	files: readonly string[],
	mode: CheckMode,
): CheckGateConfig[] {
	return gates.filter(
		(gate) =>
			(mode !== "staged" || gate.staged !== false) &&
			(gate.when === undefined || touches(files, gate.when, mode)),
	);
}

/**
 * A changed test file, or the tests next to a changed source file
 * (`a.ts` → `a.test.ts`, `a.database.test.ts`). Paths relative to `root`.
 */
export async function testsFor(
	root: string,
	files: readonly string[],
	exclude: readonly string[] = [],
): Promise<string[]> {
	const tests = new Set<string>();
	for (const file of files) {
		if (/\.test\.[cm]?[jt]sx?$/.test(file)) {
			tests.add(file);
			continue;
		}
		const source = file.match(/^(.*)\.[cm]?[jt]sx?$/);
		if (!source) continue;
		const glob = new Bun.Glob(`${source[1]}{,.*}.test.{ts,tsx,js,jsx}`);
		for await (const test of glob.scan(root)) tests.add(test);
	}
	const excluded = exclude.map((pattern) => new Bun.Glob(pattern));
	return [...tests]
		.filter(
			(test) =>
				existsSync(join(root, test)) &&
				!excluded.some((glob) => glob.match(test)),
		)
		.sort();
}
