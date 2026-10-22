import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "hanzio";

/**
 * Compare two dotted release versions.
 *
 * Numeric per segment, so `0.10.0` beats `0.9.0` — which a string compare gets
 * backwards, and which is the only comparison this needs to get right. Anything
 * unparseable sorts as 0, so a garbled version never claims to be newer.
 */
export function compareVersions(left: string, right: string): number {
	const leftParts = left.split(".");
	const rightParts = right.split(".");
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const a = Number.parseInt(leftParts[index] ?? "0", 10) || 0;
		const b = Number.parseInt(rightParts[index] ?? "0", 10) || 0;
		if (a !== b) return a < b ? -1 : 1;
	}
	return 0;
}

/** The first `major.minor.patch` in a tool's `--version` output. */
export function parseVersion(text: string): string | undefined {
	return /\d+\.\d+\.\d+/.exec(text)?.[0];
}

/** Whether `version` is at least `min` and below `below`. */
export function isVersionInRange(
	version: string,
	min: string,
	below: string,
): boolean {
	return (
		compareVersions(version, min) >= 0 && compareVersions(version, below) < 0
	);
}

/** The buncargo package: its root directory and its version. */
export interface BuncargoPackage {
	dir: string;
	version: string;
}

/**
 * The buncargo package containing `fromDir`, or `undefined` when there is
 * none (buncargo bundled into someone else's build).
 *
 * Walked up to rather than imported: the build splits shared code into chunks
 * at the root of `dist/`, so the depth from a module to the package root
 * differs between source and build. The name check keeps a bundle from
 * reporting its host's package.
 */
export function findBuncargoPackage(
	fromDir: string,
): BuncargoPackage | undefined {
	let dir = fromDir;
	while (true) {
		try {
			const pkg = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			) as { name?: unknown; version?: unknown };
			if (pkg.name === "buncargo" && typeof pkg.version === "string")
				return { dir, version: pkg.version };
		} catch {
			// No package.json at this level: keep walking.
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** This buncargo's own package, found once. */
export const buncargoPackage: () => BuncargoPackage | undefined = once(() =>
	findBuncargoPackage(dirname(fileURLToPath(import.meta.url))),
);

/** This buncargo's own package, for code that cannot run without its files. */
export function requireBuncargoPackage(): BuncargoPackage {
	const own = buncargoPackage();
	if (!own) throw new Error("Could not locate the buncargo package root.");
	return own;
}

/** This buncargo's own version, or `undefined` when it cannot be found. */
export function buncargoVersion(): string | undefined {
	return buncargoPackage()?.version;
}
