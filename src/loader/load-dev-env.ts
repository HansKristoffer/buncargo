import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
	setCachedDevEnv,
} from "./cache";
import { findConfigFile } from "./find-config-file";

const inputFileConfigs = new Set<string>();
const moduleUrls = new Map<string, string>();

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
export async function loadDevEnv<
	TConfig extends DevConfigLike = AnyDevConfig,
>(options?: {
	cwd?: string;
	/** Re-import the config entry and rebuild state. Imported dependencies remain cached. */
	reload?: boolean;
	/** Read persisted ports without probing conflicts or writing allocation state. */
	readOnly?: boolean;
	/** `--runtime`, taking precedence over env and config. */
	containerRuntime?: string;
}): Promise<DevEnvironmentFor<TConfig>> {
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
	// Config callbacks can read arbitrary environment variables. Store only a
	// digest, and invalidate resolved state whenever those inputs change.
	const environmentHash = createHash("sha256")
		.update(
			JSON.stringify(
				Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),
			),
		)
		.digest("hex");
	const identity = JSON.stringify([
		configPath,
		root,
		requested ?? null,
		options?.readOnly ?? false,
		environmentHash,
	]);
	if (!options?.reload && !inputFileConfigs.has(configPath)) {
		const cached = getCachedDevEnv(identity);
		if (cached) {
			setCachedDevEnv(cached, requested);
			return cached as DevEnvironmentFor<TConfig>;
		}
	}

	// Bun canonicalizes file: URLs before considering their query string.
	// An absolute path specifier preserves the revision and refreshes the entry.
	const moduleUrl = options?.reload
		? `${configPath}?buncargo-reload=${crypto.randomUUID()}`
		: (moduleUrls.get(configPath) ?? configPath);
	const mod = await import(moduleUrl);
	moduleUrls.set(configPath, moduleUrl);
	if (options?.reload) invalidateConfigEnvironments(configPath);
	if (!("default" in mod) || mod.default === undefined) {
		throw new Error(
			`Invalid config in "${configPath}". Use defineDevConfig() and export as default.`,
		);
	}

	// Concurrent consumers can finish the same import together. The first one
	// resolves the environment; subsequent consumers reuse that exact object.
	if (!options?.reload && !inputFileConfigs.has(configPath)) {
		const cached = getCachedDevEnv(identity);
		if (cached) {
			setCachedDevEnv(cached, requested);
			return cached as DevEnvironmentFor<TConfig>;
		}
	}

	const loaded: unknown = mod.default;
	if (mod.default?.options?.envFiles) inputFileConfigs.add(configPath);

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
		{ containerRuntime: requested, root, readOnly: options?.readOnly },
	);
	setCachedDevEnv(env, requested, identity);
	return env as DevEnvironmentFor<TConfig>;
}
