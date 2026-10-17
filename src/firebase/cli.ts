import { existsSync } from "node:fs";
import { join } from "node:path";
import { childProcessEnv } from "../core/child-env";
import { lookupOnPath } from "../core/tool-binary";
import { isVersionInRange, parseVersion } from "../core/version";

/**
 * Versions the integration is tested against. What it relies on (the
 * `--config` project directory, the hub's locator file, one clean shutdown per
 * signal) has held across these.
 */
const TESTED_FIREBASE_CLI = { min: "13.0.0", below: "16.0.0" } as const;

/**
 * The project's own `firebase-tools` first, so every checkout runs its pinned
 * version; then `PATH`. Run directly rather than through `npx` or `bunx`,
 * which forward the stop signal a second time: the CLI reads a second signal
 * as "exit now, skip the export".
 */
function findFirebaseBin(root: string, workdir: string): string | undefined {
	for (const dir of [workdir, root]) {
		const local = join(dir, "node_modules", ".bin", "firebase");
		if (existsSync(local)) return local;
	}
	return lookupOnPath("firebase");
}

export function resolveFirebaseBin(root: string, workdir: string): string {
	return findFirebaseBin(root, workdir) ?? "firebase";
}

export function isFirebaseInstalled(root: string, workdir: string): boolean {
	return findFirebaseBin(root, workdir) !== undefined;
}

export function isTestedFirebaseVersion(version: string): boolean {
	return isVersionInRange(
		version,
		TESTED_FIREBASE_CLI.min,
		TESTED_FIREBASE_CLI.below,
	);
}

/** `firebase --version`, or undefined when the binary cannot run. */
export function firebaseVersion(bin: string, cwd: string): string | undefined {
	try {
		const result = Bun.spawnSync([bin, "--version"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: childProcessEnv(),
			timeout: 30_000,
		});
		if (result.exitCode !== 0) return undefined;
		return parseVersion(result.stdout.toString());
	} catch {
		return undefined;
	}
}
