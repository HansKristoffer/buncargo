/**
 * Ensures every name in `onlyApps` exists as a key in `apps`.
 */
export function assertOnlyAppNames(
	appKeys: string[],
	onlyApps: string[] | undefined,
): void {
	if (onlyApps === undefined) return;
	const unknown = onlyApps.filter((name) => !appKeys.includes(name));
	if (unknown.length > 0) {
		throw new Error(`Unknown app name(s) in onlyApps: ${unknown.join(", ")}`);
	}
}

/**
 * Returns a subset of `apps` when `onlyApps` is set; otherwise the full map.
 * When `onlyApps` is `[]`, returns `{}`.
 */
export function pickApps<TApp>(
	apps: Readonly<Record<string, TApp>>,
	onlyApps: string[] | undefined,
): Record<string, TApp> {
	if (onlyApps === undefined) return apps as Record<string, TApp>;
	const out: Record<string, TApp> = {};
	for (const name of onlyApps) {
		const config = apps[name];
		if (config !== undefined) {
			out[name] = config;
		}
	}
	return out;
}
