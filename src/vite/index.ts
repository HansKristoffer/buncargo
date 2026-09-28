/** Configure Vite's listener and allowed hosts from Buncargo's app environment.
 * HMR follows the URL that loaded the client, so local HTTPS and remote frp URLs
 * can reach the same dev server without baking one machine's hostname into it.
 */

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
	 * Address to bind. Defaults to `127.0.0.1`.
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

/**
 * Read the injected environment.
 *
 * Exported so the resolution can be tested without constructing a Vite config.
 */
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

			return buildBuncargoViteConfig(environment, options.host ?? "127.0.0.1");
		},
	};
}
