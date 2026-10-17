import { urlHostOverride } from "./runtime-flags";

/**
 * The one URL "open" means for an app: what the TUI's `o`, `buncargo open
 * <app>` and BuncargoBar's Open button all use, recorded per app in the run
 * registry (`openUrl`) so no reader decides on its own.
 *
 * A public tunnel when the app is exposed (for a worker like Shopify's, the
 * only URL it has); else the named `https://` host when the hosts daemon is
 * serving it, otherwise loopback. Falling back to loopback is the same guard
 * the banner applies: a route is a file until the daemon picks it up, and
 * opening it earlier lands on a 404 from our own proxy. With `BUNCARGO_URL_HOST`
 * the plain URL is the one people can reach, so it wins over loopback.
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
	urlHostSet: boolean = urlHostOverride() !== undefined,
): string | undefined {
	const url =
		app.publicUrl ??
		(hostsActive || urlHostSet ? app.url : app.loopbackUrl) ??
		app.url;
	return withEntryPath(url, app.entryPath);
}

/** The parts of a live environment {@link environmentOpenUrl} reads. */
export interface OpenUrlSource {
	readonly urls: object;
	readonly loopbackUrls?: object;
	readonly publicUrls: object;
	readonly apps?: object;
	readonly hosts?: { readonly active: boolean } | null;
}

/**
 * {@link preferredAppUrl} for one app of an environment. No `hosts` record
 * means nothing is serving named hosts: opening one anyway is the silent
 * failure the loopback fallback exists to prevent.
 */
export function environmentOpenUrl(
	env: OpenUrlSource,
	app: string,
): string | undefined {
	const read = (urls: object | undefined) =>
		(urls as Record<string, string | undefined> | undefined)?.[app];
	return preferredAppUrl(
		{
			url: read(env.urls),
			loopbackUrl: read(env.loopbackUrls),
			publicUrl: read(env.publicUrls),
			entryPath: appEntryPath(
				(env.apps as Record<string, unknown> | undefined)?.[app],
			),
		},
		env.hosts?.active === true,
	);
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
