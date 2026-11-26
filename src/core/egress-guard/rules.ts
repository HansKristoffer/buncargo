/**
 * Pure policy decisions for the built-in local egress guard proxy.
 *
 * Single concern owner for allowlist matching, `NO_PROXY` construction, proxy
 * environment variables, and `NODE_USE_ENV_PROXY` version checks.
 */

import type { EgressGuardOption, ResolvedEgressGuardConfig } from "../../types";

/** Merge base `egressGuard` with an optional active profile override. */
export function resolveEgressGuard(
	base: EgressGuardOption | undefined,
	override: EgressGuardOption | undefined,
): ResolvedEgressGuardConfig | undefined {
	if (override === false) return undefined;
	if (typeof override === "object" && override.enabled === false) {
		return undefined;
	}

	const baseObj = typeof base === "object" ? base : undefined;
	const baseEnabled =
		base === true || (baseObj !== undefined && baseObj.enabled !== false);

	if (override === undefined) {
		if (!baseEnabled) return undefined;
		return {
			enabled: true,
			allow: [...(baseObj?.allow ?? [])],
			mode: baseObj?.mode ?? "block",
			...(baseObj?.apps ? { apps: [...baseObj.apps] } : {}),
		};
	}

	if (override === true) {
		return {
			enabled: true,
			allow: [...(baseObj?.allow ?? [])],
			mode: baseObj?.mode ?? "block",
			...(baseObj?.apps ? { apps: [...baseObj.apps] } : {}),
		};
	}

	const apps = override.apps ?? baseObj?.apps;
	return {
		enabled: true,
		allow: [...(override.allow ?? baseObj?.allow ?? [])],
		mode: override.mode ?? baseObj?.mode ?? "block",
		...(apps ? { apps: [...apps] } : {}),
	};
}

/** Normalize a hostname from a URL or `CONNECT` target (lowercase, unbracketed). */
function normalizeHost(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1);
	}
	return trimmed.replace(/\.$/, "");
}

/** Whether `host` is an IPv4 loopback (`127.0.0.0/8`) or RFC1918 private address. */
function isPrivateIpv4(host: string): boolean {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!match) return false;
	const octets = match.slice(1).map((part) => Number.parseInt(part, 10));
	if (octets.some((n) => n < 0 || n > 255)) return false;
	const [a, b] = octets;
	return (
		a === 127 ||
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254)
	);
}

/** Whether `host` targets the local machine (always bypassed/permitted). */
export function isLoopbackHost(rawHost: string): boolean {
	const host = normalizeHost(rawHost);
	return (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host.startsWith("127.") ||
		host === "::1" ||
		host === "0.0.0.0" ||
		host.endsWith(".localhost")
	);
}

/** Whether `host` targets loopback or an RFC1918 / link-local / ULA private IP. */
function isPrivateOrLoopbackHost(rawHost: string): boolean {
	const host = normalizeHost(rawHost);
	if (isLoopbackHost(host) || isPrivateIpv4(host)) return true;
	return (
		host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")
	);
}

/**
 * Whether an outbound target (`host`, optional `port`) is permitted by `allow`.
 *
 * Entries in `allow` support:
 * - exact hostnames (`"app.unleash-hosted.com"`)
 * - exact `host:port` (`"api.example.com:443"`)
 * - leading wildcard subdomains (`"*.unleash-hosted.com"`, `"*.example.com:443"`)
 */
export function isHostAllowed(
	rawHost: string,
	port: number | undefined,
	allow: readonly string[],
): boolean {
	const host = normalizeHost(rawHost);
	if (!host) return false;
	if (isPrivateOrLoopbackHost(host)) return true;

	for (const rawRule of allow) {
		const trimmed = rawRule.trim().toLowerCase();
		if (!trimmed) continue;

		// Split an optional trailing `:port` (ignoring IPv6 bracketed literals without port).
		let ruleHostPart = trimmed;
		let rulePort: number | undefined;
		const lastColon = trimmed.lastIndexOf(":");
		if (
			lastColon > 0 &&
			!trimmed.endsWith("]") &&
			/^\d+$/.test(trimmed.slice(lastColon + 1))
		) {
			ruleHostPart = trimmed.slice(0, lastColon);
			rulePort = Number.parseInt(trimmed.slice(lastColon + 1), 10);
		}

		if (rulePort !== undefined && port !== rulePort) continue;

		if (ruleHostPart.startsWith("*.")) {
			const bare = normalizeHost(ruleHostPart.slice(2));
			if (!bare) continue;
			if (host === bare || host.endsWith(`.${bare}`)) return true;
			continue;
		}

		if (host === normalizeHost(ruleHostPart)) return true;
	}

	return false;
}

/** Default loopback entries bypassed from the egress proxy. */
const DEFAULT_NO_PROXY = ["localhost", "127.0.0.1", "::1", ".localhost"];

/**
 * Build a deduplicated `NO_PROXY` list covering loopback, `.localhost` named
 * hosts, and any extra hostnames or TLDs (such as custom `options.hosts.tld`
 * and this machine's `localIp`).
 */
export function buildNoProxyList(extra: readonly string[] = []): string {
	const entries = new Set<string>(DEFAULT_NO_PROXY);
	for (const item of extra) {
		const trimmed = item.trim().toLowerCase();
		if (trimmed) entries.add(trimmed);
	}
	return [...entries].join(",");
}

/** Proxy environment variables injected into guarded app processes. */
export function egressGuardEnv(
	proxyUrl: string,
	noProxy: string,
): Record<string, string> {
	return {
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
		grpc_proxy: proxyUrl,
		NO_PROXY: noProxy,
		no_proxy: noProxy,
		NODE_USE_ENV_PROXY: "1",
	};
}

/** Whether `appName` receives egress-guard proxy env vars. */
export function guardsApp(
	guard: ResolvedEgressGuardConfig,
	appName: string,
): boolean {
	return guard.apps === undefined || guard.apps.includes(appName);
}

/**
 * Whether a Node.js version natively honors `NODE_USE_ENV_PROXY=1` in both
 * `http`/`https` and `fetch` (`>= 22.21.0` on Node 22, `>= 24.5.0` on Node 24,
 * or Node `>= 25`).
 */
export function supportsNodeEnvProxy(version: string): boolean {
	const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
	if (!match?.[1] || !match[2]) return false;
	const major = Number.parseInt(match[1], 10);
	const minor = Number.parseInt(match[2], 10);
	if (major >= 25) return true;
	if (major === 24) return minor >= 5;
	if (major === 22) return minor >= 21;
	return false;
}
