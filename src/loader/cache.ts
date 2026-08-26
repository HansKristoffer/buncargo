import type { AnyDevEnvironment } from "../types";

let cachedEnv: AnyDevEnvironment | null = null;
let cachedRuntimeSelection: string | undefined;

/**
 * Remember the environment together with the runtime selection it was built
 * from, not just the runtime it resolved to.
 *
 * The two are different vocabularies - a selection can be `"auto"`, which no
 * resolved runtime is ever named - so comparing a later request against the
 * resolved name would rebuild on every `--runtime=auto` call.
 */
export function setCachedDevEnv(
	env: AnyDevEnvironment,
	runtimeSelection?: string,
): void {
	cachedEnv = env;
	cachedRuntimeSelection = runtimeSelection;
}

export function getCachedDevEnv(): AnyDevEnvironment | null {
	return cachedEnv;
}

/** The `--runtime` value the cached environment was built with, if any. */
export function getCachedRuntimeSelection(): string | undefined {
	return cachedRuntimeSelection;
}

export function clearDevEnvCache(): void {
	cachedEnv = null;
	cachedRuntimeSelection = undefined;
}
