/**
 * Which loopback family a proxied dev server is actually listening on.
 *
 * Dialing `127.0.0.1` unconditionally 502s against a server bound to IPv6
 * loopback only, and Vite's default `localhost` bind does exactly that, so a
 * named URL pointing at a Vite app never resolved while a Bun app on `*:port`
 * worked. The family is probed once per port and remembered, because the
 * alternative - retrying the forward itself - cannot replay a consumed body.
 */

import { isTcpPortOpen } from "../network";

export interface UpstreamFamily {
	/** Host to hand a socket API. */
	host: string;
	/** Authority for a URL, bracketed when IPv6. */
	authority: string;
}

/** Preference order: IPv4 first, since most dev servers bind it. */
export const UPSTREAM_FAMILIES: readonly UpstreamFamily[] = [
	{ host: "127.0.0.1", authority: "127.0.0.1" },
	{ host: "::1", authority: "[::1]" },
];

/** Both families named, for an error that would otherwise blame only one. */
export function describeUpstreamFamilies(): string {
	return UPSTREAM_FAMILIES.map((family) => family.authority).join(" or ");
}

/**
 * A probe short enough that a refused IPv4 connect does not stall the request
 * that discovers an IPv6-only upstream. Loopback refusals are immediate; this
 * only bounds a firewall that blackholes instead of refusing.
 */
const PROBE_TIMEOUT_MS = 500;

export interface UpstreamResolver {
	/** The family accepting connections on `port`, or undefined if neither is. */
	resolve: (port: number) => Promise<UpstreamFamily | undefined>;
	/** Drop a remembered family after a forward against it failed. */
	forget: (port: number) => void;
}

export function createUpstreamResolver(
	options: {
		probe?: (port: number, host: string) => Promise<boolean>;
		timeoutMs?: number;
	} = {},
): UpstreamResolver {
	const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
	const probe =
		options.probe ??
		((port: number, host: string) => isTcpPortOpen(port, host, timeoutMs));
	const known = new Map<number, UpstreamFamily>();
	// Concurrent first requests for one port would otherwise each probe.
	const inFlight = new Map<number, Promise<UpstreamFamily | undefined>>();

	async function probeFamilies(
		port: number,
	): Promise<UpstreamFamily | undefined> {
		for (const family of UPSTREAM_FAMILIES) {
			if (await probe(port, family.host)) {
				known.set(port, family);
				return family;
			}
		}
		return undefined;
	}

	return {
		async resolve(port) {
			const remembered = known.get(port);
			if (remembered) return remembered;

			const pending = inFlight.get(port);
			if (pending) return pending;

			const attempt = probeFamilies(port).finally(() => {
				inFlight.delete(port);
			});
			inFlight.set(port, attempt);
			return attempt;
		},
		forget(port) {
			known.delete(port);
		},
	};
}
