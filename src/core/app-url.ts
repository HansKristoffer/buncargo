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
	app: { url?: string; loopbackUrl?: string; publicUrl?: string },
	hostsActive: boolean,
): string | undefined {
	return app.publicUrl ?? (hostsActive ? app.url : app.loopbackUrl) ?? app.url;
}
