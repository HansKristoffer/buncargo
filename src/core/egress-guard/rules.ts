/**
 * Pure policy decisions for the built-in local egress guard proxy.
 *
 * Single concern owner for allowlist matching, `NO_PROXY` construction, proxy
 * environment variables, and `NODE_USE_ENV_PROXY` version checks.
 */

import type {
	EgressGuardOption,
	ResolvedEgressGuardConfig,
	TaskConfig,
} from "../../types";

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
	if (override === undefined && !baseEnabled) return undefined;

	// `true` turns the base guard on as it is; an object overrides field by field.
	const overrideObj = typeof override === "object" ? override : undefined;
	const apps = overrideObj?.apps ?? baseObj?.apps;
	return {
		enabled: true,
		allow: [...(overrideObj?.allow ?? baseObj?.allow ?? [])],
		allowHostsOf: [
			...(overrideObj?.allowHostsOf ?? baseObj?.allowHostsOf ?? []),
		],
		mode: overrideObj?.mode ?? baseObj?.mode ?? "block",
		...(apps ? { apps: [...apps] } : {}),
	};
}

/**
 * The hosts `allowHostsOf` lets through for one process: the hostname of each
 * named key's URL in that process's final environment (secrets included).
 * `unresolved` names the keys that are unset or hold no URL with a host, so
 * the run can say why their host stays blocked.
 */
export function allowedHostsOf(
	keys: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): { hosts: string[]; unresolved: string[] } {
	const hosts = new Set<string>();
	const unresolved: string[] = [];
	for (const key of keys) {
		const host = urlHostname(env[key]);
		if (host) hosts.add(host);
		else unresolved.push(key);
	}
	return { hosts: [...hosts], unresolved };
}

/** A URL's exact hostname; never a pattern (`https://*.com` names no host). */
function urlHostname(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const host = normalizeHost(new URL(value.trim()).hostname);
		return host && !host.includes("*") ? host : undefined;
	} catch {
		return undefined;
	}
}

/** Normalize a hostname from a URL or `CONNECT` target (lowercase, unbracketed). */
export function normalizeHost(raw: string): string {
	const trimmed = raw.trim().toLowerCase();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed.slice(1, -1);
	}
	return trimmed.replace(/\.$/, "");
}

/** Parse a strict dotted-quad IPv4 literal into its four octets. */
function parseIpv4(host: string): [number, number, number, number] | undefined {
	const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
	if (!match) return undefined;
	const a = Number.parseInt(match[1] ?? "", 10);
	const b = Number.parseInt(match[2] ?? "", 10);
	const c = Number.parseInt(match[3] ?? "", 10);
	const d = Number.parseInt(match[4] ?? "", 10);
	if (a > 255 || b > 255 || c > 255 || d > 255) return undefined;
	return [a, b, c, d];
}

/** Whether `host` is an IPv4 loopback (`127.0.0.0/8`), RFC1918, or non-IMDS link-local address. */
function isPrivateIpv4(host: string): boolean {
	const octets = parseIpv4(host);
	if (!octets) return false;
	const [a, b, c, d] = octets;
	// Cloud metadata service (GCP/AWS/Azure IMDS) is never treated as local/private.
	if (a === 169 && b === 254 && c === 169 && d === 254) return false;
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
		host === "::1" ||
		host === "0.0.0.0" ||
		host.endsWith(".localhost") ||
		parseIpv4(host)?.[0] === 127
	);
}

/** Whether `host` targets loopback or an RFC1918 / link-local / ULA private IP. */
function isPrivateOrLoopbackHost(rawHost: string): boolean {
	const host = normalizeHost(rawHost);
	if (isLoopbackHost(host) || isPrivateIpv4(host)) return true;
	// Require `:` so domain names starting with `fc`/`fd` (e.g. `fcm.googleapis.com`)
	// are never mistaken for IPv6 ULA literals.
	if (!host.includes(":")) return false;
	return /^f[cd][0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host);
}

interface CompiledAllowRule {
	readonly host: string;
	readonly wildcard: boolean;
	readonly port?: number;
}

/** Pre-parse `allow` entries once for hot-path checks in the egress proxy. */
export function compileAllowRules(
	allow: readonly string[],
): (rawHost: string, port: number | undefined) => boolean {
	const rules: CompiledAllowRule[] = [];
	for (const rawRule of allow) {
		const trimmed = rawRule.trim().toLowerCase();
		if (!trimmed) continue;

		// Split an optional trailing `:port` (ignoring unbracketed IPv6 and bracketed IPv6 without port).
		let ruleHostPart = trimmed;
		let rulePort: number | undefined;
		const lastColon = trimmed.lastIndexOf(":");
		if (
			lastColon > 0 &&
			!trimmed.endsWith("]") &&
			(trimmed.startsWith("[") || trimmed.indexOf(":") === lastColon) &&
			/^\d+$/.test(trimmed.slice(lastColon + 1))
		) {
			ruleHostPart = trimmed.slice(0, lastColon);
			rulePort = Number.parseInt(trimmed.slice(lastColon + 1), 10);
		}

		if (ruleHostPart.startsWith("*.")) {
			const bare = normalizeHost(ruleHostPart.slice(2));
			if (!bare) continue;
			rules.push({ host: bare, wildcard: true, port: rulePort });
			continue;
		}

		const host = normalizeHost(ruleHostPart);
		if (host) rules.push({ host, wildcard: false, port: rulePort });
	}

	return (rawHost, port) => {
		const host = normalizeHost(rawHost);
		if (!host) return false;
		if (isPrivateOrLoopbackHost(host)) return true;

		for (const rule of rules) {
			if (rule.port !== undefined && port !== rule.port) continue;
			if (rule.wildcard) {
				if (host === rule.host || host.endsWith(`.${rule.host}`)) return true;
			} else if (host === rule.host) {
				return true;
			}
		}

		return false;
	};
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
	return compileAllowRules(allow)(rawHost, port);
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

/** Every variable {@link egressGuardEnv} sets, for a process opting out of an app's guard. */
export const EGRESS_GUARD_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"http_proxy",
	"https_proxy",
	"grpc_proxy",
	"NO_PROXY",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
] as const;

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
 * Whether a task runs behind the guard: its own `egressGuard` when set, else
 * the guard of the app whose env it borrows (`app`). A task with neither runs
 * unguarded, like a hook.
 */
export function guardsTask(
	guard: ResolvedEgressGuardConfig | undefined,
	task: Pick<TaskConfig, "app" | "egressGuard">,
): boolean {
	if (!guard) return false;
	if (task.egressGuard !== undefined) return task.egressGuard;
	return task.app !== undefined && guardsApp(guard, task.app);
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
