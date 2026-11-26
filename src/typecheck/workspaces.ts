import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isString } from "hanzio";
import { readPnpmWorkspacePackages } from "../core/package-manager";

const DEFAULT_PATTERNS = ["apps/*", "packages/*", "modules"];

/**
 * Explicit patterns win; otherwise honor `package.json` `workspaces`, then
 * `pnpm-workspace.yaml` `packages`, before falling back to defaults.
 */
export function workspacePatterns(root: string, override?: string[]): string[] {
	if (override !== undefined) return override;
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const declared = Array.isArray(pkg.workspaces)
			? pkg.workspaces
			: pkg.workspaces?.packages;
		if (Array.isArray(declared) && declared.every(isString)) return declared;
	} catch {
		// A standalone checkout without a package manifest: try pnpm-workspace.yaml.
	}
	const pnpmPackages = readPnpmWorkspacePackages(root);
	if (pnpmPackages) return pnpmPackages;
	return DEFAULT_PATTERNS;
}
