import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { globPaths } from "./glob";
import { workspacePatterns } from "./workspaces";

/**
 * Prefer the project's own `tsc`. `bunx tsc` with no local TypeScript downloads
 * whatever is latest on npm (today, 7.x) and that compiler rejects `process`
 * unless `types` names `node` — which is how a perfectly valid `dev.config.ts`
 * failed the first time this check ran in a monorepo that only installs
 * TypeScript inside workspaces.
 */
export async function resolveProjectTsc(root: string): Promise<string> {
	let current = root;
	while (true) {
		const candidate = join(current, "node_modules", "typescript", "bin", "tsc");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	// The first workspace, in path order, with a TypeScript of its own.
	for (const workspace of globPaths(workspacePatterns(root), root, {
		directories: true,
	})) {
		const candidate = join(
			root,
			workspace,
			"node_modules",
			"typescript",
			"bin",
			"tsc",
		);
		if (existsSync(candidate)) return candidate;
	}

	throw new Error(
		"No project TypeScript compiler found. Install typescript in the root or a declared workspace.",
	);
}
