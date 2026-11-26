import { mapValues, trimTrailingSlash } from "hanzio";
import type {
	SecretsHolder,
	SecretsScopeConfig,
	SecretsScopeInput,
} from "../../types";
import { secretsEnvironment } from "../runtime-flags";

/**
 * What an Infisical scope means, resolved from dev.config.ts. Pure: no
 * fetching, no state.
 */

export interface InfisicalScope {
	projectId: string;
	/** Scope the CLI user session to this organization. */
	organizationId?: string;
	environment: string;
	siteUrl: string;
	/** Folder, matching hanzio's secretPath. Default "/". */
	path: string;
	/** Inject only these keys. */
	only?: readonly string[];
	/** Never inject these keys. */
	exclude?: readonly string[];
}

/** Same default as hanzio: the EU cloud. */
const DEFAULT_INFISICAL_SITE_URL = "https://eu.infisical.com";

/** Narrow a {@link SecretsScopeInput} to a layered scope array. */
export function isScopeList(
	input: SecretsScopeInput | false | undefined,
): input is readonly SecretsScopeConfig[] {
	return Array.isArray(input);
}

/** The primary defaults scope (first entry when config-level defaults are layered). */
export function primaryScope(
	input: SecretsScopeInput | false | undefined,
): SecretsScopeConfig | undefined {
	if (!input) return undefined;
	return isScopeList(input) ? input[0] : input;
}

/** Whether a scope entry sets any field beyond `required`. */
function hasScopeFields(scope: SecretsScopeConfig): boolean {
	return (
		scope.projectId !== undefined ||
		scope.organizationId !== undefined ||
		scope.environment !== undefined ||
		scope.siteUrl !== undefined ||
		scope.path !== undefined ||
		scope.only !== undefined ||
		scope.exclude !== undefined
	);
}

/** The folder a scope reads; scopes that differ only in their filters share one fetch. */
export function folderKey(scope: InfisicalScope): string {
	return `${scope.siteUrl}|${scope.organizationId ?? ""}|${scope.projectId}|${scope.environment}|${scope.path}`;
}

/** A scope's identity: its folder and the keys it lets through. */
export function scopeKey(scope: InfisicalScope): string {
	const filter = (keys: readonly string[] | undefined) =>
		keys ? [...keys].sort().join(",") : "";
	return `${folderKey(scope)}|${filter(scope.only)}|${filter(scope.exclude)}`;
}

/** Connection-only defaults extracted from a layered config's first entry. */
function connectionDefaultsOf(
	input: SecretsScopeInput | false | undefined,
): SecretsScopeConfig | undefined {
	const primary = primaryScope(input);
	if (!primary) return undefined;
	if (!isScopeList(input)) return primary;
	return {
		...(primary.projectId ? { projectId: primary.projectId } : {}),
		...(primary.organizationId
			? { organizationId: primary.organizationId }
			: {}),
		...(primary.environment ? { environment: primary.environment } : {}),
		...(primary.siteUrl ? { siteUrl: primary.siteUrl } : {}),
	};
}

/**
 * Resolve one scope entry against config-level defaults and optional sibling
 * connection fields (`projectId`, `organizationId`, `environment`, `siteUrl`).
 *
 * `inheritFilters` is true only for single-object scopes inheriting a
 * single-object config default; layered arrays keep `only`/`exclude` strictly
 * per-layer so config filters never leak into an overlay layer.
 */
function resolveSingleScope(
	scope: SecretsScopeConfig | undefined,
	defaults: SecretsScopeConfig | undefined,
	connectionFallback: SecretsScopeConfig | undefined,
	env: NodeJS.ProcessEnv,
	inheritFilters: boolean,
): InfisicalScope | undefined {
	const projectId =
		scope?.projectId ?? connectionFallback?.projectId ?? defaults?.projectId;
	if (!projectId) return undefined;
	const organizationId =
		scope?.organizationId ??
		connectionFallback?.organizationId ??
		defaults?.organizationId;
	const siteUrl =
		scope?.siteUrl ??
		connectionFallback?.siteUrl ??
		defaults?.siteUrl ??
		DEFAULT_INFISICAL_SITE_URL;
	const environment =
		scope?.environment ??
		connectionFallback?.environment ??
		defaults?.environment ??
		secretsEnvironment(env) ??
		"dev";
	const only = scope?.only ?? (inheritFilters ? defaults?.only : undefined);
	const exclude =
		scope?.exclude ?? (inheritFilters ? defaults?.exclude : undefined);
	return {
		projectId,
		...(organizationId ? { organizationId } : {}),
		environment,
		siteUrl: trimTrailingSlash(siteUrl),
		path: scope?.path ?? defaults?.path ?? "/",
		...(only ? { only } : {}),
		...(exclude ? { exclude } : {}),
	};
}

/**
 * Resolve a single scope against the config-level defaults.
 *
 * Returns undefined when no project id is in reach, which is how something
 * that declared nothing keeps today's behaviour. Without an environment in the
 * config, `SECRETS_ENV` in `env` names it, else `dev`.
 */
export function resolveScope(
	scope: SecretsScopeConfig | false | undefined,
	defaults: SecretsScopeInput | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): InfisicalScope | undefined {
	if (scope === false || defaults === false) return undefined;
	return resolveSingleScope(
		scope,
		connectionDefaultsOf(defaults),
		undefined,
		env,
		!isScopeList(defaults),
	);
}

/**
 * Resolve a single or layered scope input against config-level defaults into an
 * ordered list of concrete scopes (later scopes override earlier ones).
 *
 * When a layered array omits `projectId`, `organizationId`, `environment` or
 * `siteUrl` on later entries, those connection fields fall back to the first
 * entry and then to `defaults`; `path`, `only` and `exclude` never leak across
 * layers.
 */
export function resolveScopes(
	scope: SecretsScopeInput | false | undefined,
	defaults: SecretsScopeInput | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): InfisicalScope[] {
	if (scope === false || defaults === false) return [];

	const baseDefaults = connectionDefaultsOf(defaults);
	if (scope === undefined) {
		if (!defaults) return [];
		if (isScopeList(defaults)) {
			const [first] = defaults;
			return defaults.flatMap((entry, index) => {
				const resolved = resolveSingleScope(
					entry,
					undefined,
					index > 0 ? first : undefined,
					env,
					false,
				);
				return resolved ? [resolved] : [];
			});
		}
		const resolved = resolveSingleScope(
			undefined,
			defaults,
			undefined,
			env,
			true,
		);
		return resolved ? [resolved] : [];
	}

	if (isScopeList(scope)) {
		const [first] = scope;
		const primary = scope.flatMap((entry, index) => {
			const resolved = resolveSingleScope(
				entry,
				baseDefaults,
				index > 0 ? first : undefined,
				env,
				false,
			);
			return resolved ? [resolved] : [];
		});
		if (isScopeList(defaults) && defaults.length > 1 && scope !== defaults) {
			const [firstDefault, ...overlays] = defaults;
			const seen = new Set(primary.map(scopeKey));
			const trailing = overlays.flatMap((entry) => {
				const resolved = resolveSingleScope(
					entry,
					baseDefaults,
					firstDefault,
					env,
					false,
				);
				return resolved && !seen.has(scopeKey(resolved)) ? [resolved] : [];
			});
			return [...primary, ...trailing];
		}
		return primary;
	}

	// An app opting into layered config-level defaults with `{}` or `{ required }`
	// inherits every layer from `defaults`. One declaring its own fields (e.g.
	// `{ path: "/frontend" }`) resolves against the first default layer and
	// keeps any trailing config/profile overlay layers on top.
	if (isScopeList(defaults)) {
		if (!hasScopeFields(scope)) {
			return resolveScopes(undefined, defaults, env);
		}
		const [firstDefault, ...overlays] = defaults;
		const primary = resolveSingleScope(
			scope,
			firstDefault,
			undefined,
			env,
			true,
		);
		const trailing = overlays.flatMap((entry) => {
			const resolved = resolveSingleScope(
				entry,
				baseDefaults,
				firstDefault,
				env,
				false,
			);
			return resolved ? [resolved] : [];
		});
		return primary ? [primary, ...trailing] : trailing;
	}

	const resolved = resolveSingleScope(
		scope,
		baseDefaults,
		undefined,
		env,
		true,
	);
	return resolved ? [resolved] : [];
}

/**
 * Merge a base `secrets` config with an override (used by `mergeConfigs` and
 * active `profiles.<name>.secrets`).
 */
export function mergeSecretsConfig(
	base: SecretsScopeInput | false | undefined,
	override: SecretsScopeInput | false | undefined,
): SecretsScopeInput | false | undefined {
	if (override === undefined) return base;
	if (override === false || base === undefined || base === false) {
		return override;
	}

	const basePrimary = primaryScope(base);
	if (isScopeList(override)) {
		const [first, ...rest] = override;
		if (!first || !basePrimary) return override;
		return [
			{
				...(basePrimary.projectId ? { projectId: basePrimary.projectId } : {}),
				...(basePrimary.organizationId
					? { organizationId: basePrimary.organizationId }
					: {}),
				...(basePrimary.environment
					? { environment: basePrimary.environment }
					: {}),
				...(basePrimary.siteUrl ? { siteUrl: basePrimary.siteUrl } : {}),
				...first,
			},
			...rest,
		];
	}

	if (isScopeList(base)) {
		return base.map((entry, index) =>
			index === 0 ? { ...entry, ...override } : entry,
		);
	}

	return { ...base, ...override };
}

/** Deduplicated union of `required` keys across one or layered scopes. */
export function requiredSecretKeys(
	input: SecretsScopeInput | false | undefined,
): string[] {
	if (!input) return [];
	const list = isScopeList(input) ? input : [input];
	return [...new Set(list.flatMap((entry) => entry.required ?? []))];
}

/**
 * Bake the config-level defaults into every opted-in app's own scope(s).
 *
 * The spawners read the scope off `app.secrets` and nothing else, so the
 * defaults have to be resolved before the apps leave the config. Passing them
 * alongside instead would be one more argument for the next spawner to forget,
 * which is exactly how the CLI's own spawn path missed this in 9.2.0.
 */
export function applySecretDefaults<
	TApps extends Record<string, { secrets?: SecretsScopeInput | false }>,
>(
	apps: TApps,
	defaults: SecretsScopeInput | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): TApps {
	if (defaults === false) {
		return mapValues(apps, (app) => ({ ...app, secrets: false })) as TApps;
	}

	if (!Object.values(apps).some((app) => app.secrets)) return apps;

	const baseDefaults = connectionDefaultsOf(defaults);
	return mapValues(apps, (app) => {
		const own = app.secrets;
		if (!own) return app;

		if (isScopeList(own)) {
			const [first] = own;
			const resolvedList: SecretsScopeConfig[] = own.map((entry, index) => {
				const resolved = resolveSingleScope(
					entry,
					baseDefaults,
					index > 0 ? first : undefined,
					env,
					false,
				);
				return {
					...(resolved ?? entry),
					...(entry.required ? { required: entry.required } : {}),
				};
			});
			if (isScopeList(defaults) && defaults.length > 1 && own !== defaults) {
				const [firstDefault, ...overlays] = defaults;
				const seen = new Set(
					resolvedList.flatMap((entry) => {
						const resolved = resolveSingleScope(
							entry,
							undefined,
							undefined,
							env,
							false,
						);
						return resolved ? [scopeKey(resolved)] : [];
					}),
				);
				for (const overlay of overlays) {
					const resolved = resolveSingleScope(
						overlay,
						baseDefaults,
						firstDefault,
						env,
						false,
					);
					if (resolved && !seen.has(scopeKey(resolved))) {
						resolvedList.push({
							...resolved,
							...(overlay.required ? { required: overlay.required } : {}),
						});
					}
				}
			}
			return { ...app, secrets: resolvedList };
		}

		// Single-object app scope against layered config/profile defaults:
		// `{}` / `{ required }` inherits every layer as written; an app setting
		// its own fields (e.g. `{ path: "/frontend" }`) resolves against layer 0
		// and keeps trailing overlay layers (e.g. prod feature flags) on top.
		if (isScopeList(defaults)) {
			const resolvedList = resolveScopes(own, defaults, env);
			if (resolvedList.length > 0) {
				const withRequired: SecretsScopeConfig[] = resolvedList.map(
					(entry, index) => {
						const defaultReq = defaults[index]?.required;
						const required =
							index === 0
								? [...new Set([...(defaultReq ?? []), ...(own.required ?? [])])]
								: (defaultReq ?? []);
						return required.length > 0 ? { ...entry, required } : entry;
					},
				);
				return {
					...app,
					secrets: withRequired.length === 1 ? withRequired[0] : withRequired,
				};
			}
		}

		return {
			...app,
			secrets: {
				...(resolveSingleScope(
					own,
					baseDefaults,
					undefined,
					env,
					!isScopeList(defaults),
				) ?? own),
				// Not part of the scope's identity, so resolveSingleScope drops it.
				...(own.required ? { required: own.required } : {}),
			},
		};
	}) as TApps;
}

/** One distinct scope and who reads it: `config`, an app's name, or another label. */
export interface CollectedScope {
	scope: InfisicalScope;
	usedBy: string[];
}

/**
 * The distinct scopes a set of readers names, in first-seen order. A reader
 * that names nothing reads the defaults; one with `false`, or no project id in
 * reach, reads none. An app that declares nothing is not opted in, so callers
 * leave such apps out.
 */
export function collectScopes(
	readers: Iterable<
		readonly [user: string, scope: SecretsScopeInput | false | undefined]
	>,
	defaults: SecretsScopeInput | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CollectedScope[] {
	const scopes = new Map<string, CollectedScope>();
	for (const [user, config] of readers) {
		for (const scope of resolveScopes(config, defaults, env)) {
			const key = scopeKey(scope);
			const known = scopes.get(key);
			if (known) {
				if (!known.usedBy.includes(user)) known.usedBy.push(user);
			} else {
				scopes.set(key, { scope, usedBy: [user] });
			}
		}
	}
	return [...scopes.values()];
}

/**
 * Match a secret key against an exact name or glob pattern (`*` matches any
 * characters, `?` matches one character).
 */
export function matchesSecretPattern(key: string, pattern: string): boolean {
	if (!pattern.includes("*") && !pattern.includes("?")) {
		return key === pattern;
	}
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`).test(key);
}

/** The keys of `values` the scope lets through (`only`, then `exclude`). */
export function filterScopeKeys(
	scope: InfisicalScope,
	values: Record<string, string>,
): Record<string, string> {
	if (!scope.only && !scope.exclude) return values;
	const only = scope.only;
	const exclude = scope.exclude;
	return Object.fromEntries(
		Object.entries(values).filter(([key]) => {
			if (only && !only.some((pattern) => matchesSecretPattern(key, pattern))) {
				return false;
			}
			if (exclude?.some((pattern) => matchesSecretPattern(key, pattern))) {
				return false;
			}
			return true;
		}),
	);
}

/** `project env/path @ site`, the way buncargo prints a scope. */
export function describeScope(scope: InfisicalScope): string {
	const path = scope.path === "/" ? "" : scope.path;
	const org = scope.organizationId ? ` org ${scope.organizationId}` : "";
	return `${scope.projectId} ${scope.environment}${path} @ ${scope.siteUrl}${org}`;
}

/**
 * `secrets.required` keys an app would start without, per app.
 *
 * Checked against everything the app will actually get: the fetched secrets,
 * the developer's environment and the computed env.
 */
export function missingRequiredSecrets(
	apps: Record<string, SecretsHolder>,
	provided: (name: string) => Record<string, string | undefined>,
): Record<string, string[]> {
	const missing: Record<string, string[]> = {};
	for (const [name, app] of Object.entries(apps)) {
		const required = requiredSecretKeys(app.secrets);
		if (required.length === 0) continue;
		const absent = missingKeys(required, provided(name));
		if (absent.length > 0) missing[name] = absent;
	}
	return missing;
}

/**
 * The `required` keys `env` leaves unset or empty: the rule `dev` refuses to
 * start on, and the one `buncargo secrets ls` reports with.
 */
export function missingKeys(
	required: readonly string[],
	env: Record<string, string | undefined>,
): string[] {
	return required.filter((key) => !env[key]);
}
