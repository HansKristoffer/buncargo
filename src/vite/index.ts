/** Configure Vite's listener and allowed hosts from Buncargo's app environment.
 * HMR follows the URL that loaded the client, so local HTTPS and Tailscale Serve
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
	config: () => BuncargoViteConfig;
}

export interface BuncargoViteConfig {
	server: {
		port?: number;
		host?: string;
		allowedHosts?: string[];
	};
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
}

/** The parts of the injected environment this plugin reads. */
export interface BuncargoViteEnvironment {
	port?: number;
	allowedHosts: string[];
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
	// `PORT` is what buncargo sets for the app it spawned. `<APP>_PORT` covers a
	// Vite process started by hand outside the dev run.
	const port =
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

/** Preserve Vite's origin-relative WebSocket defaults; both Buncargo proxies support upgrades. */
export function buildBuncargoViteConfig(
	environment: BuncargoViteEnvironment,
	host: string,
): BuncargoViteConfig {
	const { port, allowedHosts } = environment;

	return {
		server: {
			...(port === undefined ? {} : { port }),
			host,
			...(allowedHosts.length > 0 ? { allowedHosts } : {}),
		},
	};
}

export function buncargoVite(
	options: BuncargoViteOptions = {},
): BuncargoVitePlugin {
	return {
		name: "buncargo",
		config() {
			// Read inside `config`, not at module scope: Vite loads the config file
			// once per process, and a watched restart should see current values.
			const env = options.env ?? process.env;
			const appName = options.app ?? env.BUNCARGO_APP_NAME;
			return buildBuncargoViteConfig(
				readBuncargoViteEnvironment(env, appName),
				options.host ?? "127.0.0.1",
			);
		},
	};
}
