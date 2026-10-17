import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * The version in the `package.json` of the buncargo package containing
 * `fromDir`, or `undefined` when there is none (buncargo bundled into someone
 * else's build).
 *
 * Walked up to rather than imported: the build splits shared code into chunks
 * at the root of `dist/`, so the relative path differs between source and
 * build. The name check keeps a bundle from reporting its host's version.
 */
export function readBuncargoVersion(fromDir: string): string | undefined {
	let dir = fromDir;
	for (let depth = 0; depth < 6; depth++) {
		try {
			const pkg = JSON.parse(
				readFileSync(join(dir, "package.json"), "utf8"),
			) as { name?: unknown; version?: unknown };
			if (pkg.name === "buncargo" && typeof pkg.version === "string")
				return pkg.version;
		} catch {
			// No package.json at this level: keep walking.
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

let ownVersion: { value: string | undefined } | undefined;

/** This buncargo's own version, read once. */
export function buncargoVersion(): string | undefined {
	ownVersion ??= {
		value: readBuncargoVersion(dirname(fileURLToPath(import.meta.url))),
	};
	return ownVersion.value;
}
