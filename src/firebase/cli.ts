import { existsSync } from "node:fs";
import { join } from "node:path";
import { lookupOnPath } from "../core/tool-binary";

/**
 * Versions the integration is tested against. What it relies on (the
 * `--config` project directory, the hub's locator file, one clean shutdown per
 * signal) has held across these.
 */
const TESTED_FIREBASE_CLI = { min: [13, 0, 0], below: [16, 0, 0] } as const;

/**
 * The project's own `firebase-tools` first, so every checkout runs its pinned
 * version; then `PATH`. Run directly rather than through `npx` or `bunx`,
 * which forward the stop signal a second time: the CLI reads a second signal
 * as "exit now, skip the export".
 */
export function resolveFirebaseBin(root: string, workdir: string): string {
	for (const dir of [workdir, root]) {
		const local = join(dir, "node_modules", ".bin", "firebase");
		if (existsSync(local)) return local;
	}
	return lookupOnPath("firebase") ?? "firebase";
}

export function isFirebaseInstalled(root: string, workdir: string): boolean {
	return resolveFirebaseBin(root, workdir) !== "firebase";
}

export function parseFirebaseVersion(
	text: string,
): [number, number, number] | undefined {
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match
		? [Number(match[1]), Number(match[2]), Number(match[3])]
		: undefined;
}

export function isTestedFirebaseVersion(version: readonly number[]): boolean {
	const compare = (a: readonly number[], b: readonly number[]) => {
		for (let index = 0; index < 3; index++) {
			const diff = (a[index] ?? 0) - (b[index] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	};
	return (
		compare(version, TESTED_FIREBASE_CLI.min) >= 0 &&
		compare(version, TESTED_FIREBASE_CLI.below) < 0
	);
}

/** `firebase --version`, or undefined when the binary cannot run. */
export function firebaseVersion(bin: string, cwd: string): string | undefined {
	try {
		const result = Bun.spawnSync([bin, "--version"], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			env: process.env,
			timeout: 30_000,
		});
		if (result.exitCode !== 0) return undefined;
		return parseFirebaseVersion(result.stdout.toString())?.join(".");
	} catch {
		return undefined;
	}
}
