import type { AnyDevEnvironment } from "../types";

let cachedEnv: AnyDevEnvironment | null = null;

export function setCachedDevEnv(env: AnyDevEnvironment): void {
	cachedEnv = env;
}

export function getCachedDevEnv(): AnyDevEnvironment | null {
	return cachedEnv;
}

export function clearDevEnvCache(): void {
	cachedEnv = null;
}
