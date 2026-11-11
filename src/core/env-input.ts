import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import type { EnvInputFile } from "../types";

export interface EnvInput {
	/**
	 * The keys the checkout declared, in its files and `buncargo env set`
	 * overrides, each with the shell's value when it has one. The only part
	 * of the input a computed environment carries: the rest of the shell is
	 * the developer's own (tokens, `PWD`, `SHLVL`), not the project's.
	 */
	readonly declared: Readonly<Record<string, string>>;
	/** Every inherited variable over the declared ones, for `ctx.env` in callbacks. */
	readonly merged: Readonly<Record<string, string>>;
}

/**
 * Files are defaults, then the checkout's `buncargo env set` overrides, then
 * the shell. No process.env mutation and no writes to credentials.
 */
export function loadEnvInput(
	root: string,
	files: readonly EnvInputFile[] = [],
	inherited: NodeJS.ProcessEnv,
	overrides: Readonly<Record<string, string>>,
): EnvInput {
	const declared: Record<string, string> = {};

	for (const file of files) {
		const input = typeof file === "string" ? { path: file } : file;
		const path = resolve(root, input.path);

		try {
			Object.assign(declared, parseEnv(readFileSync(path, "utf8")));
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

	Object.assign(declared, overrides);
	const merged: Record<string, string> = { ...declared };
	// Shell values override file defaults without changing process.env.
	for (const [name, value] of Object.entries(inherited)) {
		if (value === undefined) continue;
		merged[name] = value;
		if (name in declared) declared[name] = value;
	}
	return { declared: Object.freeze(declared), merged: Object.freeze(merged) };
}
