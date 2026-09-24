import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How another process calls back into this buncargo.
 *
 * The menu bar runs every mutation as `<program> <script> stop …`, so this
 * has to name buncargo's own CLI. It used to be `process.argv[1]`, which is
 * only that when buncargo *is* the process: under a script that calls
 * `dev.start()` or wraps `runCli`, `argv[1]` is the user's script, and Stop
 * ran it again — starting a second environment — instead of stopping one.
 */
export interface CliInvocation {
	program: string;
	script?: string;
}

/**
 * The CLI entry of the buncargo package containing `fromDir`.
 *
 * Walks up to the package's `src` or `dist` directory and returns the entry
 * of the same flavor, so a checkout running from source calls back into
 * source and an installed package into its build. Mixing them would stop a
 * run with a different version of the code that started it.
 */
export function findCliEntry(fromDir: string): string | undefined {
	let dir = fromDir;
	for (let depth = 0; depth < 8; depth++) {
		const parent = dirname(dir);
		const flavor = basename(dir);
		if (
			(flavor === "src" || flavor === "dist") &&
			existsSync(join(parent, "package.json"))
		) {
			const entry =
				flavor === "src"
					? join(parent, "src", "cli", "bin.ts")
					: join(parent, "dist", "cli", "bin.js");
			if (existsSync(entry)) return entry;
		}
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * The invocation recorded in a run entry.
 *
 * Falls back to `buncargo` on `PATH` when the package layout is unrecognizable
 * (buncargo bundled into someone else's build): a command that may not be
 * found fails harmlessly, where guessing a script could run the wrong one.
 */
export function buncargoCli(): CliInvocation {
	const entry = findCliEntry(dirname(fileURLToPath(import.meta.url)));
	return entry
		? { program: process.execPath, script: entry }
		: { program: "/usr/bin/env", script: "buncargo" };
}
