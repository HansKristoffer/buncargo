import {
	BAR_SOURCE_VERSION,
	type BarRelease,
	type InstalledBarInfo,
} from "./menubar";
import { readJsonDocumentSync, writeJsonDocumentSync } from "./registry-file";
import { chownToInvokingUser, stateFilePath } from "./state-paths";

/**
 * Deciding whether the installed BuncargoBar is too old, without costing
 * `buncargo dev` anything.
 *
 * The CLI is the only updater (see `core/menubar.ts`), so this is where "is the
 * app behind?" gets answered. Two tiers, because they are genuinely different
 * problems:
 *
 * - **Required.** The app cannot decode the `runs.json` this CLI writes, so its
 *   menu is empty and the user has no way to know why. Updated without asking:
 *   they already opted into the app, and the alternative is a broken one.
 * - **Optional.** The app works, a newer release exists. One hint line, once
 *   per release, never a download.
 *
 * Everything network lives behind a cache file, because `dev` runs far more
 * often than GitHub's 60-requests-per-hour-per-IP allowance for anonymous
 * callers, and a rate-limited check must not become a failed one.
 */

export const BAR_CHECK_FILENAME = "bar-check.json";
const CACHE_VERSION = 1;

/** Normal cadence. The app being one release behind is not urgent. */
const HINT_TTL_MS = 24 * 60 * 60 * 1000;
/** When the app cannot read the registry at all, a day-old answer is too old. */
const REQUIRED_TTL_MS = 60 * 60 * 1000;

export interface BarCheckCache {
	version: number;
	checkedAt: string;
	latest?: BarRelease;
	/** The version whose hint has already been printed. */
	hintedVersion?: string;
}

export function getBarCheckPath(home?: string): string {
	return stateFilePath(BAR_CHECK_FILENAME, home);
}

function isBarCheckCache(value: unknown): BarCheckCache | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const cache = value as Partial<BarCheckCache>;
	if (cache.version !== CACHE_VERSION) return undefined;
	if (typeof cache.checkedAt !== "string") return undefined;
	return cache as BarCheckCache;
}

export function readBarCheckCache(): BarCheckCache | undefined {
	return readJsonDocumentSync(getBarCheckPath(), isBarCheckCache);
}

export function writeBarCheckCache(
	cache: Omit<BarCheckCache, "version">,
): void {
	writeJsonDocumentSync(
		getBarCheckPath(),
		{ version: CACHE_VERSION, ...cache } satisfies BarCheckCache,
		{ afterWrite: chownToInvokingUser },
	);
}

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

export type BarUpdateDecision =
	/** Nothing to do, and nothing to say. */
	| { action: "none" }
	/** The app cannot read this CLI's registry. Update it now. */
	| { action: "update" }
	/** A newer release exists and the user has not been told about it yet. */
	| { action: "hint"; version: string };

export interface BarUpdateInput {
	installed: InstalledBarInfo | undefined;
	/** `REGISTRY_VERSION` from the run registry — what this CLI writes. */
	cliRegistryVersion: number;
	/** Newest published release, when one is known. */
	latestVersion?: string;
	/** `hintedVersion` from the cache. */
	hintedVersion?: string;
}

/**
 * The whole policy, as a pure function.
 *
 * Kept separate from the fetching and the printing so every row of the table
 * in `docs/bar-update-plan.md` is one assertion in a unit test.
 */
export function decideBarUpdate(input: BarUpdateInput): BarUpdateDecision {
	const { installed, cliRegistryVersion, latestVersion, hintedVersion } = input;
	// Not installed is the offer's business, not the updater's.
	if (!installed) return { action: "none" };

	if (installed.registryVersion < cliRegistryVersion) {
		return { action: "update" };
	}

	// A source build has no release version to compare, and comparing anyway
	// would nag forever about a build that is usually ahead of every release.
	const current = installed.version;
	if (!current || current === BAR_SOURCE_VERSION) return { action: "none" };

	if (!latestVersion) return { action: "none" };
	if (compareVersions(latestVersion, current) <= 0) return { action: "none" };
	// Once per release: a hint that reappears on every `dev` is noise.
	if (hintedVersion === latestVersion) return { action: "none" };
	return { action: "hint", version: latestVersion };
}

/**
 * Is the cached answer still good enough to skip the network?
 *
 * The required tier gets the short TTL: an app that cannot read the registry is
 * broken right now, and waiting up to a day for a cache to expire before even
 * looking for the fix is the wrong trade.
 */
export function isCacheFresh(
	cache: BarCheckCache | undefined,
	options: { required: boolean; now?: number },
): boolean {
	if (!cache) return false;
	const checkedAt = Date.parse(cache.checkedAt);
	if (Number.isNaN(checkedAt)) return false;
	const age = (options.now ?? Date.now()) - checkedAt;
	// A clock that moved backwards makes every cache look fresh forever.
	if (age < 0) return false;
	return age < (options.required ? REQUIRED_TTL_MS : HINT_TTL_MS);
}
