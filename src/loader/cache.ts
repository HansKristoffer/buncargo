import type { AnyDevEnvironment } from "../types";

let cachedEnv: AnyDevEnvironment | null = null;
const environments = new Map<string, AnyDevEnvironment>();

/** getDevEnv() retains its historical meaning: the most recently loaded env. */
export function setCachedDevEnv(
	env: AnyDevEnvironment,
	identity?: string,
): void {
	cachedEnv = env;
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
		? cachedEnv
		: (environments.get(identity) ?? null);
}

export function clearDevEnvCache(): void {
	cachedEnv = null;
	environments.clear();
}

/** A re-import changes every cached runtime/read mode for this config. */
export function invalidateConfigEnvironments(configPath: string): void {
	for (const identity of environments.keys()) {
		if ((JSON.parse(identity) as unknown[])[0] === configPath)
			environments.delete(identity);
	}
}
