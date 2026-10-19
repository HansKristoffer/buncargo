import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findMonorepoRoot } from "../core/ports";

export const CONFIG_FILES = ["dev.config.ts", "dev.config.js"];

/** The config file's name directly in `root`, without walking up. */
export function findRootConfigFile(root: string): string | null {
	return CONFIG_FILES.find((file) => existsSync(join(root, file))) ?? null;
}

export function findConfigFile(startDir: string): string | null {
	let currentDir = resolve(startDir);

	while (true) {
		for (const file of CONFIG_FILES) {
			const configPath = join(currentDir, file);
			if (existsSync(configPath)) {
				return configPath;
			}
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) {
			return null;
		}

		currentDir = parentDir;
	}
}

/**
 * The checkout a command run from `startDir` belongs to, as `loadDevEnv`
 * resolves it: the repository root above the nearest config, symlinks
 * resolved. Undefined outside any checkout.
 */
export function findCheckoutRoot(startDir: string): string | undefined {
	const found = findConfigFile(startDir);
	return found
		? realpathSync(findMonorepoRoot(dirname(realpathSync(found))))
		: undefined;
}
