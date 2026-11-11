import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { syncConfiguredCheckoutFiles } from "../core/checkout-files";
import { findMonorepoRoot } from "../core/ports";
import { createDevEnvironment } from "../environment";
import type {
	AnyDevConfig,
	AnyDevEnvironment,
	AppConfig,
	DevConfig,
	DevConfigLike,
	DevEnvironmentFor,
	ServiceConfig,
} from "../types";
import {
	getCachedDevEnv,
	invalidateConfigEnvironments,
	isConfigCacheable,
	setCachedDevEnv,
	setConfigCacheable,
} from "./cache";
import { findConfigFile } from "./find-config-file";

/**
 * Each config's module URL and reload revision. Not part of the environment
 * cache, so `clearDevEnvCache()` keeps it: dropping it would import the
 * module from before the last reload again.
 */
const configModules = new Map<string, { url: string; revision: number }>();
/** Shared loads under way, by identity, with the environment each runs under. */
const inflight = new Map<
	string,
	{ loading: Promise<AnyDevEnvironment>; variables: EnvironmentVariables }
>();

type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

/**
 * The `process.env` each cached environment was built under. Config callbacks
 * can read any variable, so a cached environment serves a load only while
 * every variable is the same. A copy compared on a hit, not a digest in the
 * identity, so a first load, with nothing to compare against, hashes nothing.
 */
const builtUnder = new WeakMap<AnyDevEnvironment, EnvironmentVariables>();

function sameVariables(
	a: EnvironmentVariables | undefined,
	b: EnvironmentVariables,
): boolean {
	if (!a) return false;
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length &&
		keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
	);
}

/** The cached environment for `identity`, if it was built under `variables`. */
function cachedFor(
	identity: string,
	variables: EnvironmentVariables,
): AnyDevEnvironment | undefined {
	const cached = getCachedDevEnv(identity);
	return cached && sameVariables(builtUnder.get(cached), variables)
		? cached
		: undefined;
}

interface LoadDevEnvOptions {
	cwd?: string;
	/** Re-import the config entry and rebuild state. Imported dependencies remain cached. */
	reload?: boolean;
	/** Create independent session state while reusing the imported config. */
	fresh?: boolean;
	/** `--runtime`, taking precedence over env and config. */
	containerRuntime?: string;
	/**
	 * Bring `options.checkoutFiles` up to date before `envFiles` are read.
	 * Default true; false for commands that only inspect (`doctor`).
	 */
	syncCheckoutFiles?: boolean;
}

/**
 * Load `dev.config.ts` from disk and build its dev environment.
 *
 * The config is imported at runtime, so its shape cannot be inferred. Pass the
 * config type to keep `defineDevConfig` inference (`ports`, `urls`,
 * `getEnvVar`) for programmatic consumers:
 *
 * ```ts
 * import type devConfig from "./dev.config";
 * const env = await loadDevEnv<typeof devConfig>();
 * ```
 *
 * Callers that do not know the config statically (the CLI) can omit it and get
 * the widened {@link AnyDevEnvironment} shape.
 */
export async function loadDevEnv<TConfig extends DevConfigLike = AnyDevConfig>(
	options?: LoadDevEnvOptions,
): Promise<DevEnvironmentFor<TConfig>> {
	const requested = options?.containerRuntime;

	const cwd = resolve(options?.cwd ?? process.cwd());
	const foundPath = findConfigFile(cwd);
	const configPath = foundPath ? realpathSync(foundPath) : null;

	if (!configPath) {
		throw new Error(
			"No config file found. Create dev.config.ts with: export default defineDevConfig({ ... })",
		);
	}

	const root = realpathSync(findMonorepoRoot(dirname(configPath)));
	const variables: EnvironmentVariables = { ...process.env };
	const identity = JSON.stringify([configPath, root, requested ?? null]);
	const shared =
		!options?.reload && !options?.fresh && isConfigCacheable(configPath);
	if (shared) {
		const cached = cachedFor(identity, variables);
		if (cached) {
			setCachedDevEnv(cached, configPath);
			return cached as DevEnvironmentFor<TConfig>;
		}
		// A load of this identity already under way builds the one environment
		// both callers get: two would each claim a session of their own.
		const pending = inflight.get(identity);
		if (pending && sameVariables(pending.variables, variables))
			return (await pending.loading) as DevEnvironmentFor<TConfig>;
	}

	const loading = importAndBuild(
		configPath,
		root,
		identity,
		variables,
		options,
	);
	if (!shared) return (await loading) as DevEnvironmentFor<TConfig>;
	inflight.set(identity, { loading, variables });
	try {
		return (await loading) as DevEnvironmentFor<TConfig>;
	} finally {
		if (inflight.get(identity)?.loading === loading) inflight.delete(identity);
	}
}

async function importAndBuild(
	configPath: string,
	root: string,
	identity: string,
	variables: EnvironmentVariables,
	options: LoadDevEnvOptions | undefined,
): Promise<AnyDevEnvironment> {
	const requested = options?.containerRuntime;
	// Bun canonicalizes file: URLs before considering their query string.
	// An absolute path specifier preserves the revision and refreshes the entry.
	let moduleState = configModules.get(configPath);
	if (!moduleState) {
		moduleState = { url: configPath, revision: 0 };
		configModules.set(configPath, moduleState);
	}
	const revision = options?.reload
		? ++moduleState.revision
		: moduleState.revision;
	const moduleUrl = options?.reload
		? `${configPath}?buncargo-reload=${crypto.randomUUID()}`
		: moduleState.url;
	const mod = await import(moduleUrl);
	const isCurrentRevision =
		revision === moduleState.revision &&
		(options?.reload || moduleUrl === moduleState.url);
	if (!("default" in mod) || mod.default === undefined) {
		throw new Error(
			`Invalid config in "${configPath}". Use defineDevConfig() and export as default.`,
		);
	}
	// A slow import from before a reload must not restore its old module URL
	// or invalidate the environment that the newer reload already published.
	if (isCurrentRevision) {
		moduleState.url = moduleUrl;
		if (options?.reload) invalidateConfigEnvironments(configPath);
	}

	// Concurrent consumers can finish the same import together. The first one
	// resolves the environment; subsequent consumers reuse that exact object.
	if (!options?.reload && !options?.fresh && isConfigCacheable(configPath)) {
		const cached = cachedFor(identity, variables);
		if (cached) {
			setCachedDevEnv(cached, configPath);
			return cached;
		}
	}

	const loaded: unknown = mod.default;
	if (isCurrentRevision)
		setConfigCacheable(configPath, !mod.default?.options?.envFiles);

	// Before the environment is built: it reads required `envFiles`, which a
	// fresh checkout only has once they are copied in.
	if (options?.syncCheckoutFiles !== false)
		await syncConfiguredCheckoutFiles(root, loaded);

	// The dynamic import is untyped, so the caller's TConfig is the only source
	// of shape information. This cast is the single trust boundary for it.
	//
	// `AnyDevConfig` is deliberately not the cast target: its callbacks carry
	// placeholder signatures so every concrete config stays assignable to it,
	// which also means it cannot be handed to something that calls them.
	const env = createDevEnvironment(
		loaded as DevConfig<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>,
		{ containerRuntime: requested, root },
	);
	builtUnder.set(env, variables);
	if (isCurrentRevision)
		setCachedDevEnv(env, configPath, options?.fresh ? undefined : identity);
	return env;
}
