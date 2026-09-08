import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { EnvInputFile } from "../types";

/** Files are defaults. No process.env mutation and no writes to credentials. */
export function loadEnvInput(
	root: string,
	files: readonly EnvInputFile[] = [],
	inherited: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
	const values: Record<string, string> = {};

	for (const file of files) {
		const input = typeof file === "string" ? { path: file } : file;
		const path = resolve(root, input.path);

		try {
			Object.assign(values, parseEnv(readFileSync(path, "utf8")));
		} catch (error) {
			if (
				input.optional &&
				(error as NodeJS.ErrnoException).code === "ENOENT"
			) {
				continue;
			}
			throw new Error(`Cannot load environment input ${path}`, {
				cause: error,
			});
		}
	}

	// Shell values override file defaults without changing process.env.
	for (const [name, value] of Object.entries(inherited))
		if (value !== undefined) {
			values[name] = value;
		}
	return Object.freeze(values);
}
