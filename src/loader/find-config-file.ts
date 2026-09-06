import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILES = [
	"dev.config.ts",
	"dev.config.js",
	"dev-tools.config.ts",
	"dev-tools.config.js",
];

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
