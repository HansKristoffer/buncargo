import { existsSync } from "node:fs";
import { join } from "node:path";

const GIB = 1024 ** 3;
const MIN_AUTO_HEAP_GIB = 1;
const MAX_AUTO_HEAP_GIB = 8;
const EXPLICIT_HEAP_PATTERN = /^(?:-Xmx)?[1-9]\d*[kmgKMG]?$/;

/**
 * Whether `JAVA_HOME` points to a missing or broken JDK (no `bin/java`).
 * The Pub/Sub and Firestore emulators fail if `JAVA_HOME` is stale even when a
 * working `java` is on `PATH`.
 */
export function isBrokenJavaHome(
	javaHome: string | undefined,
	exists: (path: string) => boolean = existsSync,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (!javaHome || !javaHome.trim()) return false;
	const binary = platform === "win32" ? "java.exe" : "java";
	return !exists(join(javaHome.trim(), "bin", binary));
}

/** Empty `CLOUDSDK_CONFIG` directory inside this checkout's emulator temp dir. */
export function emulatorCloudSdkDir(emulatorTmpDirectory: string): string {
	return join(emulatorTmpDirectory, "gcloud");
}

/**
 * Resolve `javaHeap` to a JVM size string (`"4g"`, `"6g"`), or `undefined`
 * when unset. `"auto"` takes half of `totalMemoryBytes` in GiB, floored and
 * clamped to `1g..8g`. Rejects malformed values at config time.
 */
export function resolveJavaHeap(
	javaHeap: string | undefined,
	totalMemoryBytes: number,
): string | undefined {
	if (javaHeap === undefined) return undefined;
	const trimmed = javaHeap.trim();
	if (!trimmed) return undefined;
	if (trimmed === "auto") {
		const halfGib = Math.floor(totalMemoryBytes / GIB / 2);
		const clamped = Math.min(
			MAX_AUTO_HEAP_GIB,
			Math.max(MIN_AUTO_HEAP_GIB, halfGib),
		);
		return `${clamped}g`;
	}

	if (!EXPLICIT_HEAP_PATTERN.test(trimmed)) {
		throw new Error(
			`Invalid firebase() javaHeap "${trimmed}". Expected "auto" or a JVM heap size such as "2g", "4096m", or "6g".`,
		);
	}

	return trimmed.replace(/^-Xmx/, "");
}

/**
 * Append `-Xmx<heap>` to `JAVA_TOOL_OPTIONS` while preserving existing flags.
 * Returns `undefined` when `heap` is unset or `existing` already sets `-Xmx`.
 */
export function mergeJavaToolOptions(
	existing: string | undefined,
	heap: string | undefined,
): string | undefined {
	if (!heap) return undefined;
	const current = existing?.trim() ?? "";
	if (/(?:^|\s)-Xmx\S*/.test(current)) return undefined;

	const flag = heap.startsWith("-Xmx") ? heap : `-Xmx${heap}`;
	return current ? `${current} ${flag}` : flag;
}
