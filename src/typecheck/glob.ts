import { type Dirent, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The paths under `root` that any of `patterns` matches, relative to it,
 * sorted, each once. A `!pattern` (as `workspaces` allows) leaves out what it
 * matches. Nothing inside `node_modules` and no dot entry matches.
 */
export function globPaths(
	patterns: readonly string[],
	root: string,
	{ directories = false }: { directories?: boolean } = {},
): string[] {
	const clean = (pattern: string) => pattern.replace(/^\.\//, "");
	const negated = patterns
		.filter((pattern) => pattern.startsWith("!"))
		.map((pattern) => new Bun.Glob(clean(pattern.slice(1))));
	const paths = new Set<string>();
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) continue;
		const glob = new Bun.Glob(clean(pattern));
		for (const path of glob.scanSync({ cwd: root, onlyFiles: !directories })) {
			if (path.split("/").includes("node_modules")) continue;
			if (negated.some((negation) => negation.match(path))) continue;
			if (directories && !isDirectory(join(root, path))) continue;
			paths.add(path);
		}
	}
	return [...paths].sort();
}

/**
 * The `.ts` and `.tsx` files under `dir`. A walk rather than a glob, so it
 * never descends into `node_modules` or a dot directory.
 */
export function countTypeScriptFiles(dir: string): number {
	let count = 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules")
				count += countTypeScriptFiles(join(dir, entry.name));
		} else if (entry.isFile() && /\.tsx?$/.test(entry.name)) count += 1;
	}
	return count;
}
