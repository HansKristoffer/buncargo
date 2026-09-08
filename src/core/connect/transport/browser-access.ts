import type { IncomingMessage, ServerResponse } from "node:http";
import { makeSecret } from "../protocol";

/** HTTP siblings from the same remote run may call each other with private browser cookies. */
export interface BrowserPeers {
	origins: ReadonlySet<string>;
	cookies(): string[];
}

/** Keep browser credentials local; the application still receives its own Authorization header. */
export function browserAccess(port: () => number, browser?: BrowserPeers) {
	const bootstrap = makeSecret(),
		cookie = makeSecret();
	const cookieName = () => `bc_connect_${port()}`;
	const origin = () => `http://127.0.0.1:${port()}`;
	const browserCookie = () =>
		`${cookieName()}=${cookie}; HttpOnly; SameSite=Strict; Path=/`;
	function allowed(req: IncomingMessage): boolean {
		if (req.headers.host !== `127.0.0.1:${port()}`) return false;
		if (
			req.headers.origin &&
			req.headers.origin !== origin() &&
			!isTrustedOrigin(req)
		)
			return false;
		if (
			req.headers["sec-fetch-site"] &&
			!["same-origin", "none"].includes(
				String(req.headers["sec-fetch-site"]),
			) &&
			!isTrustedOrigin(req)
		)
			return false;
		return (
			req.headers.cookie
				?.split(";")
				.some((c) => c.trim() === `${cookieName()}=${cookie}`) ?? false
		);
	}
	function upstreamHeaders(req: IncomingMessage) {
		const h = { ...req.headers };
		delete h["proxy-authorization"];
		h.cookie = h.cookie
			?.split(";")
			.filter((c) => !c.trim().startsWith("bc_connect_"))
			.join(";");
		// Host the origin expects is supplied by its own dev server; localhost works with Vite defaults.
		h.host = "localhost";
		h["x-forwarded-host"] = req.headers.host;
		h["x-forwarded-proto"] = "http";
		return h;
	}

	function isTrustedOrigin(req: IncomingMessage): boolean {
		return !!req.headers.origin && !!browser?.origins.has(req.headers.origin);
	}

	/** Answer bootstrap, preflight and denied requests before opening an upstream connection. */
	function handle(req: IncomingMessage, res: ServerResponse): boolean {
		const url = new URL(req.url ?? "/", origin());
		const trustedOrigin = isTrustedOrigin(req);
		if (trustedOrigin && req.headers.host === `127.0.0.1:${port()}`) {
			res.setHeader(
				"access-control-allow-origin",
				req.headers.origin as string,
			);
			res.setHeader("access-control-allow-credentials", "true");
			if (req.method === "OPTIONS") {
				res.setHeader(
					"access-control-allow-methods",
					"GET, POST, PUT, PATCH, DELETE, OPTIONS",
				);
				res.setHeader(
					"access-control-allow-headers",
					req.headers["access-control-request-headers"] ??
						"content-type, authorization",
				);
				res.writeHead(204);
				res.end();
				return true;
			}
		}
		if (
			req.headers.host === `127.0.0.1:${port()}` &&
			url.pathname === "/__buncargo_open" &&
			url.searchParams.get("key") === bootstrap
		) {
			res.writeHead(303, {
				"set-cookie": [browserCookie(), ...(browser?.cookies() ?? [])],
				location: "/",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			});
			res.end();
			return true;
		}
		if (!allowed(req)) {
			res.writeHead(403);
			res.end("Open this service from BuncargoBar");
			return true;
		}
		return false;
	}

	return {
		allowed,
		handle,
		upstreamHeaders,
		isTrustedOrigin,
		origin,
		get url() {
			return `${origin()}/__buncargo_open?key=${bootstrap}`;
		},
		get cookie() {
			return browserCookie();
		},
	};
}
