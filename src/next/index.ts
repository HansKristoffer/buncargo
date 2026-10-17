/**
 * Let a Next.js dev server answer on this checkout's named hosts, tailnet
 * address and tunnels.
 *
 * ```ts
 * // next.config.ts
 * import { withBuncargo } from "buncargo/next";
 * export default withBuncargo({ reactStrictMode: true });
 * ```
 *
 * Next blocks cross-origin requests to its dev resources (`/_next/*`, the HMR
 * socket) from hosts outside `allowedDevOrigins`, which by default covers
 * `localhost` and its subdomains (only one label deep before Next 16.3). A
 * page opened any other way loads its HTML and then gets a 403 for every
 * script: by Tailscale address, as BuncargoBar opens apps on a tailnet, through
 * `BUNCARGO_URL_HOST`, on a hosts `tld` other than `localhost`, or through a
 * tunnel. The port needs nothing: `next dev` reads `PORT`.
 *
 * Imports nothing but `node:os`, through `tailscaleAddress`: it is loaded by
 * users' `next.config.ts`.
 */

import { tailscaleAddress } from "../core/tailscale";

/** Next's phase for `next dev`; the others get the config unchanged. */
const DEVELOPMENT_PHASE = "phase-development-server";

/** The parts of a Next config this touches, declared here rather than imported. */
export interface BuncargoNextConfigShape {
	allowedDevOrigins?: string[];
	experimental?: {
		serverActions?: { allowedOrigins?: string[] } & Record<string, unknown>;
	} & Record<string, unknown>;
}

/** A Next config: an object, or the function Next calls with the phase. */
export type NextConfigInput<T extends object> =
	| T
	| ((phase: string, context: { defaultConfig: unknown }) => T | Promise<T>);

export interface BuncargoNextOptions {
	/** Environment to read. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

/** Origins the dev server should accept, derived from the injected environment. */
export interface BuncargoNextOrigins {
	/** For `allowedDevOrigins`: named hosts, the URL host override, tailnet, tunnels. */
	devOrigins: string[];
	/** For Server Actions: the tunnels' hosts, which a proxy may not forward. */
	serverActionOrigins: string[];
}

function hostnameOf(url: string): string | undefined {
	try {
		return new URL(url).hostname || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read the injected environment.
 *
 * Exported so the resolution can be tested without loading Next.
 */
export function readBuncargoNextOrigins(
	env: NodeJS.ProcessEnv,
	tailnet: string | undefined,
): BuncargoNextOrigins {
	// Buncargo names the hosts Vite should allow in its own syntax, where a
	// leading dot means "and every subdomain". Next spells that `**.`; its `*.`
	// matches exactly one label.
	const allowedHosts = (env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => (entry.startsWith(".") ? `**${entry}` : entry));
	const tunnels = Object.entries(env)
		.filter(([name]) => name.endsWith("_PUBLIC_URL"))
		.map(([, value]) => (value ? hostnameOf(value) : undefined))
		.filter((host) => host !== undefined);

	return {
		devOrigins: [
			...new Set([...allowedHosts, ...(tailnet ? [tailnet] : []), ...tunnels]),
		],
		serverActionOrigins: [...new Set(tunnels)],
	};
}

/** Add the origins to a resolved config, keeping every origin it lists itself. */
export function applyBuncargoNextOrigins<T extends object>(
	config: T,
	origins: BuncargoNextOrigins,
): T & BuncargoNextConfigShape {
	const shape = config as T & BuncargoNextConfigShape;
	const merge = (own: string[] | undefined, added: string[]) => [
		...new Set([...(own ?? []), ...added]),
	];
	const serverActions = shape.experimental?.serverActions;

	return {
		...shape,
		...(origins.devOrigins.length > 0
			? {
					allowedDevOrigins: merge(shape.allowedDevOrigins, origins.devOrigins),
				}
			: {}),
		...(origins.serverActionOrigins.length > 0
			? {
					experimental: {
						...shape.experimental,
						serverActions: {
							...serverActions,
							allowedOrigins: merge(
								serverActions?.allowedOrigins,
								origins.serverActionOrigins,
							),
						},
					},
				}
			: {}),
	};
}

/**
 * Wrap a Next config. Only `next dev` sees the added origins, so a
 * `next build` run inside a buncargo environment bakes none of them in.
 */
export function withBuncargo<T extends object>(
	config: NextConfigInput<T>,
	options: BuncargoNextOptions = {},
): (
	phase: string,
	context: { defaultConfig: unknown },
) => Promise<T & BuncargoNextConfigShape> {
	return async (phase, context) => {
		const resolved =
			typeof config === "function" ? await config(phase, context) : config;
		if (phase !== DEVELOPMENT_PHASE) return resolved;
		// Read on each call, not at import: a restarted dev server should see
		// the current tunnel URLs.
		const env = options.env ?? process.env;
		return applyBuncargoNextOrigins(
			resolved,
			readBuncargoNextOrigins(env, tailscaleAddress()),
		);
	};
}
