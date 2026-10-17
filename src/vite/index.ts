/** Configure Vite's listener and allowed hosts from Buncargo's app environment.
 * HMR follows the URL that loaded the client, so local HTTPS and remote frp URLs
 * can reach the same dev server without baking one machine's hostname into it.
 */

import { tailscaleAddress } from "../core/tailscale";
import {
	buildBuncargoViteConfig,
	defaultBuncargoViteHost,
	readBuncargoViteEnvironment,
	resolveBuncargoViteProxy,
} from "./resolve";

/**
 * The shape Vite needs from a plugin, declared here rather than imported.
 *
 * `config` is a Vite hook; typing it against our own narrow view keeps the
 * plugin assignable to Vite's `PluginOption` without a runtime dependency.
 */
export interface BuncargoVitePlugin {
	name: string;
	config: (
		config?: unknown,
		context?: { command: string; isPreview?: boolean },
	) => Promise<BuncargoViteConfig>;
}

export interface BuncargoViteConfig {
	server: {
		port?: number;
		/** Set with `port`: a Vite that drifts to the next port is unreachable. */
		strictPort?: boolean;
		host?: string;
		allowedHosts?: string[];
		proxy?: Record<string, BuncargoViteProxyRule>;
	};
}

/** One `server.proxy` entry, in the shape Vite takes. */
export interface BuncargoViteProxyRule {
	target: string;
	changeOrigin: boolean;
	ws: boolean;
}

export interface BuncargoViteOptions {
	/**
	 * App key in `dev.config.ts`. Defaults to `BUNCARGO_APP_NAME`, which
	 * buncargo injects when it spawns the app.
	 */
	app?: string;
	/**
	 * Address to bind. Defaults to `127.0.0.1`, or `0.0.0.0` when other
	 * machines reach this one: `BUNCARGO_URL_HOST` is set, or it is on a
	 * tailnet, where BuncargoBar opens apps by its Tailscale IP.
	 *
	 * Vite's default `localhost` resolves to `[::1]` on many systems, and
	 * anything dialing IPv4 then gets a connection refused.
	 */
	host?: string;
	/** Environment to read. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Proxy path prefixes to other apps: `{ '/api': 'api' }`.
	 *
	 * The target is the app's loopback URL, never its named `https://` one,
	 * and the incoming Host is kept (`changeOrigin: false`), so the app sees
	 * the public hostname behind a tunnel. Proxying to the named URL with the
	 * Host kept is what loops: the hosts proxy routes that Host straight back
	 * to this Vite, and answers `508 Loop Detected`.
	 */
	proxy?: Record<string, string>;
}

export function buncargoVite(
	options: BuncargoViteOptions = {},
): BuncargoVitePlugin {
	return {
		name: "buncargo",
		async config() {
			// Read inside `config`, not at module scope: Vite loads the config file
			// once per process, and a watched restart should see current values.
			const env = options.env ?? process.env;
			const appName = options.app ?? env.BUNCARGO_APP_NAME;
			const environment = {
				...readBuncargoViteEnvironment(env, appName),
				proxy: options.proxy
					? resolveBuncargoViteProxy(env, options.proxy)
					: undefined,
			};

			return buildBuncargoViteConfig(
				environment,
				options.host ?? defaultBuncargoViteHost(env, tailscaleAddress()),
			);
		},
	};
}
