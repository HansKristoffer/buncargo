import type { AnyDevEnvironment } from "../types";

let cachedEnv: AnyDevEnvironment | null = null;
let cachedRuntimeSelection: string | undefined;
const environments = new Map<string, AnyDevEnvironment>();

/** getDevEnv() retains its historical meaning: the most recently loaded env. */
export function setCachedDevEnv(
	env: AnyDevEnvironment,
	runtimeSelection?: string,
	identity?: string,
): void {
	cachedEnv = env;
	cachedRuntimeSelection = runtimeSelection;
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

/** The explicit runtime selection the most recently loaded environment used. */
export function getCachedRuntimeSelection(): string | undefined {
	return cachedRuntimeSelection;
}

export function clearDevEnvCache(): void {
	cachedEnv = null;
	cachedRuntimeSelection = undefined;
	environments.clear();
}

/** A re-import changes every cached runtime/read mode for this config. */
export function invalidateConfigEnvironments(configPath: string): void {
	for (const identity of environments.keys()) {
		if ((JSON.parse(identity) as unknown[])[0] === configPath)
			environments.delete(identity);
	}
}
