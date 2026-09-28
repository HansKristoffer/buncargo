import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { findMonorepoRoot } from "../core/ports";

/**
 * Whether a path exists, relative to the monorepo root.
 *
 * For `checks` in a dev config: `check: () => exists('packages/api/generated')`.
 * Resolved against the root rather than the working directory, because
 * `buncargo dev` is run from anywhere inside the checkout.
 */
export function exists(path: string): boolean {
	return existsSync(
		isAbsolute(path) ? path : resolve(findMonorepoRoot(), path),
	);
}
