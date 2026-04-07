import type { AppConfig } from "../types";

/**
 * Ensures every name in `onlyApps` exists as a key in `apps`.
 */
export function assertOnlyAppNames(
	appKeys: string[],
	onlyApps: string[] | undefined,
): void {
	if (onlyApps === undefined) return;
	const unknown = onlyApps.filter((n) => !appKeys.includes(n));
	if (unknown.length > 0) {
		throw new Error(`Unknown app name(s) in onlyApps: ${unknown.join(", ")}`);
	}
}

/**
 * Returns a subset of `apps` when `onlyApps` is set; otherwise the full map.
 * When `onlyApps` is `[]`, returns `{}`.
 */
export function pickApps<TApps extends Record<string, AppConfig>>(
	apps: TApps,
	onlyApps: string[] | undefined,
): Record<string, AppConfig> {
	if (onlyApps === undefined) return apps;
	const out: Record<string, AppConfig> = {};
	for (const name of onlyApps) {
		const config = apps[name];
		if (config !== undefined) {
			out[name] = config;
		}
	}
	return out;
}
