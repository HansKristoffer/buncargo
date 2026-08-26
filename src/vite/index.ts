/**
 * A Vite plugin that configures the dev server from what buncargo injected.
 *
 * Without it, every Vite app in a buncargo repo hand-writes the same three
 * things: a loopback `server.host` (Vite's default `localhost` binds IPv6 only),
 * an `allowedHosts` entry for the named `.localhost` host, and an HMR block
 * pointing at the HTTPS proxy rather than the Vite port. All three are derivable
 * from the environment buncargo already sets, so none of them should be the
 * consumer's problem.
 *
 * Vite stays an optional peer dependency: the return value is typed
 * structurally, so importing this never pulls Vite into a non-Vite consumer.
 */

import { DEFAULT_HOSTS_DAEMON_PORT } from "../core/runtime-flags";

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

export interface BuncargoViteHmrConfig {
	protocol: "wss";
	host: string;
	clientPort: number;
}

export interface BuncargoViteConfig {
	server: {
		port?: number;
		host?: string;
		allowedHosts?: string[];
		hmr?: BuncargoViteHmrConfig;
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
	hostname?: string;
	hostsPort: number;
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
		hostname: env.BUNCARGO_APP_HOSTNAME,
		hostsPort: parsePort(env.BUNCARGO_HOSTS_PORT) ?? DEFAULT_HOSTS_DAEMON_PORT,
		allowedHosts,
	};
}

/**
 * Build the `server` config from an already-read environment.
 *
 * HMR is only overridden when a named host is active: otherwise the browser
 * reaches Vite directly and Vite's own defaults are correct. When it is, the
 * page is served from `https://<host>` on the proxy port, so the HMR socket has
 * to be `wss` to that hostname and port rather than the Vite port.
 */
export function buildBuncargoViteConfig(
	environment: BuncargoViteEnvironment,
	host: string,
): BuncargoViteConfig {
	const { port, hostname, hostsPort, allowedHosts } = environment;

	return {
		server: {
			...(port === undefined ? {} : { port }),
			host,
			...(allowedHosts.length > 0 ? { allowedHosts } : {}),
			...(hostname
				? {
						hmr: {
							protocol: "wss" as const,
							host: hostname,
							clientPort: hostsPort,
						},
					}
				: {}),
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
