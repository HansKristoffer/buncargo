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
