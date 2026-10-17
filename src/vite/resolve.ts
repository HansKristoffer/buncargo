/**
 * How `buncargoVite` turns the injected environment into a Vite config, kept
 * apart from the plugin so it can be tested without a Vite config file. Not a
 * public entry point: `buncargo/vite` exports the plugin and its types only.
 */

import type { BuncargoViteConfig, BuncargoViteProxyRule } from "./index";

/** The parts of the injected environment this plugin reads. */
export interface BuncargoViteEnvironment {
	port?: number;
	allowedHosts: string[];
	proxy?: Record<string, BuncargoViteProxyRule>;
}

function parsePort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const port = Number.parseInt(value, 10);
	return Number.isFinite(port) && port > 0 ? port : undefined;
}

/** Read the injected environment. */
export function readBuncargoViteEnvironment(
	env: NodeJS.ProcessEnv,
	appName: string | undefined,
): BuncargoViteEnvironment {
	// `FRONTEND_PORT` first: only Shopify CLI sets it, and it then proxies to
	// exactly that port while `PORT` may name another process's. `PORT` is what
	// buncargo sets for the app it spawned. `<APP>_PORT` covers a Vite process
	// started by hand outside the dev run.
	const port =
		parsePort(env.FRONTEND_PORT) ??
		parsePort(env.PORT) ??
		(appName ? parsePort(env[`${appName.toUpperCase()}_PORT`]) : undefined);

	const allowedHosts = (env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);

	return {
		port,
		allowedHosts,
	};
}

/**
 * Resolve `proxy: { '/api': 'api' }` to each app's loopback URL.
 *
 * `<APP>_LOOPBACK_URL` is in every buncargo-spawned process; `<APP>_PORT` is
 * the fallback for a Vite started by some other tool with the env exported.
 * A target that cannot be resolved throws: a proxy silently left out answers
 * every `/api` request with Vite's own 404.
 */
export function resolveBuncargoViteProxy(
	env: NodeJS.ProcessEnv,
	proxy: Record<string, string>,
): Record<string, BuncargoViteProxyRule> {
	return Object.fromEntries(
		Object.entries(proxy).map(([path, app]) => {
			const name = app.toUpperCase();
			const port = parsePort(env[`${name}_PORT`]);
			const target =
				env[`${name}_LOOPBACK_URL`] ??
				(port === undefined ? undefined : `http://127.0.0.1:${port}`);
			if (!target) {
				throw new Error(
					`buncargoVite: cannot proxy ${path} to "${app}": neither ${name}_LOOPBACK_URL nor ${name}_PORT is set. Start Vite through buncargo, or export the env with \`buncargo exec\`.`,
				);
			}
			return [path, { target, changeOrigin: false, ws: true }];
		}),
	);
}

/** Preserve Vite's origin-relative WebSocket defaults; both Buncargo proxies support upgrades. */
export function buildBuncargoViteConfig(
	environment: BuncargoViteEnvironment,
	host: string,
): BuncargoViteConfig {
	const { port, allowedHosts, proxy } = environment;

	return {
		server: {
			...(port === undefined ? {} : { port, strictPort: true }),
			host,
			...(allowedHosts.length > 0 ? { allowedHosts } : {}),
			...(proxy && Object.keys(proxy).length > 0 ? { proxy } : {}),
		},
	};
}

/**
 * `0.0.0.0` when another machine opens this app, `127.0.0.1` otherwise.
 * `BUNCARGO_TAILNET_DIRECTORY=0` keeps a tailnet machine's apps local.
 */
export function defaultBuncargoViteHost(
	env: NodeJS.ProcessEnv,
	tailnet: string | undefined,
): string {
	const remote =
		env.BUNCARGO_URL_HOST?.trim() ||
		(tailnet && env.BUNCARGO_TAILNET_DIRECTORY !== "0");
	return remote ? "0.0.0.0" : "127.0.0.1";
}
