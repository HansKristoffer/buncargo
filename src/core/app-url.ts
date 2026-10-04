/**
 * The one URL "open" means for an app: what the TUI's `o`, `buncargo open
 * <app>` and BuncargoBar's Open button all use, recorded per app in the run
 * registry (`openUrl`) so no reader decides on its own.
 *
 * A public tunnel when the app is exposed (for a worker like Shopify's, the
 * only URL it has); else the named `https://` host when the hosts daemon is
 * serving it, otherwise loopback. Falling back to loopback is the same guard
 * the banner applies: a route is a file until the daemon picks it up, and
 * opening it earlier lands on a 404 from our own proxy.
 */
export function preferredAppUrl(
	app: {
		url?: string;
		loopbackUrl?: string;
		publicUrl?: string;
		/** The app's `entryPath`: where people actually start, e.g. `/app/`. */
		entryPath?: string;
	},
	hostsActive: boolean,
): string | undefined {
	const url =
		app.publicUrl ?? (hostsActive ? app.url : app.loopbackUrl) ?? app.url;
	return withEntryPath(url, app.entryPath);
}

/** `url` with `entryPath` as its path. Only "open" URLs get it: env vars stay origins. */
export function withEntryPath(
	url: string | undefined,
	entryPath: string | undefined,
): string | undefined {
	if (!url || !entryPath) return url;
	try {
		return new URL(entryPath, url).toString();
	} catch {
		return url;
	}
}

/** An app config's `entryPath`, read from wherever an untyped config sits. */
export function appEntryPath(app: unknown): string | undefined {
	const entryPath = (app as { entryPath?: unknown } | undefined)?.entryPath;
	return typeof entryPath === "string" ? entryPath : undefined;
}
