import type { AnyDevEnvironment } from "../types";

/** The most recently loaded env, and the config it was built from. */
let cached: { env: AnyDevEnvironment; configPath: string } | null = null;
const environments = new Map<string, AnyDevEnvironment>();
/**
 * Configs whose environment is never served from cache: they name `envFiles`,
 * whose contents can change between loads without the config changing.
 * Decided again on every import, so a config that drops them is cached again.
 */
const uncacheable = new Set<string>();

/** getDevEnv() retains its historical meaning: the most recently loaded env. */
export function setCachedDevEnv(
	env: AnyDevEnvironment,
	configPath: string,
	identity?: string,
): void {
	cached = { env, configPath };
	if (identity !== undefined) {
		environments.delete(identity);
		environments.set(identity, env);
		// Bound memory for long-lived tools that visit many roots/env variants.
		if (environments.size > 32) {
			const oldest = environments.keys().next().value;
			if (oldest !== undefined) environments.delete(oldest);
		}
	}
}

export function getCachedDevEnv(identity?: string): AnyDevEnvironment | null {
	return identity === undefined
		? (cached?.env ?? null)
		: (environments.get(identity) ?? null);
}

export function setConfigCacheable(configPath: string, cacheable: boolean) {
	if (cacheable) uncacheable.delete(configPath);
	else uncacheable.add(configPath);
}

export function isConfigCacheable(configPath: string): boolean {
	return !uncacheable.has(configPath);
}

/**
 * Forget every environment. The imported config modules are kept: they are
 * the module cache's, and a reload's newer module must stay the one served.
 */
export function clearDevEnvCache(): void {
	cached = null;
	environments.clear();
	uncacheable.clear();
}

/** A re-import changes every cached runtime/read mode for this config. */
export function invalidateConfigEnvironments(configPath: string): void {
	for (const identity of environments.keys()) {
		if ((JSON.parse(identity) as unknown[])[0] === configPath)
			environments.delete(identity);
	}
	// `getDevEnv()` must not keep answering with the config before the
	// reload, least of all when the reload then fails.
	if (cached?.configPath === configPath) cached = null;
}
