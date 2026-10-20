import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRootWideFile } from "../../../typecheck/changed";
import type { CheckGateConfig } from "../../../types";

export type CheckMode = "changed" | "staged" | "all";

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
