import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_PATTERNS = ["apps/*", "packages/*", "modules"];

/** Explicit patterns win; otherwise honor package.json workspaces before defaults. */
export function workspacePatterns(root: string, override?: string[]): string[] {
	if (override !== undefined) return override;
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const declared = Array.isArray(pkg.workspaces)
			? pkg.workspaces
			: pkg.workspaces?.packages;
		if (
			Array.isArray(declared) &&
			declared.every((entry) => typeof entry === "string")
		)
			return declared;
	} catch {
		// A standalone checkout without a package manifest keeps legacy discovery.
	}
	return DEFAULT_PATTERNS;
}
