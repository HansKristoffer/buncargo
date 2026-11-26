import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Canonical absolute path for comparing checkout roots across symlinks
 * (e.g. macOS `/var` vs `/private/var`). Falls back to `resolve(base, path)`
 * when the path does not exist on disk.
 */
export function canonicalCheckoutPath(
	path: string,
	base: string = process.cwd(),
): string {
	const resolved = resolve(base, path);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}
