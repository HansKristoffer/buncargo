import { mapValues, trimTrailingSlash } from "hanzio";
import type { SecretsHolder, SecretsScopeConfig } from "../../types";
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

/**
 * Resolve a scope against the config-level defaults.
 *
 * Returns undefined when no project id is in reach, which is how something
 * that declared nothing keeps today's behaviour. Without an environment in the
 * config, `SECRETS_ENV` in `env` names it, else `dev`.
 */
export function resolveScope(
	scope: SecretsScopeConfig | false | undefined,
	defaults: SecretsScopeConfig | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): InfisicalScope | undefined {
	if (scope === false || defaults === false) return undefined;

	const projectId = scope?.projectId ?? defaults?.projectId;
	if (!projectId) return undefined;
	const organizationId = scope?.organizationId ?? defaults?.organizationId;
	const only = scope?.only ?? defaults?.only;
	const exclude = scope?.exclude ?? defaults?.exclude;
	return {
		projectId,
		...(organizationId ? { organizationId } : {}),
		environment:
			scope?.environment ??
			defaults?.environment ??
			secretsEnvironment(env) ??
			"dev",
		siteUrl: trimTrailingSlash(
			scope?.siteUrl ?? defaults?.siteUrl ?? DEFAULT_INFISICAL_SITE_URL,
		),
		path: scope?.path ?? defaults?.path ?? "/",
		...(only ? { only } : {}),
		...(exclude ? { exclude } : {}),
	};
}

/**
 * Bake the config-level defaults into every opted-in app's own scope.
 *
 * The spawners read the scope off `app.secrets` and nothing else, so the
 * defaults have to be resolved before the apps leave the config. Passing them
 * alongside instead would be one more argument for the next spawner to forget,
 * which is exactly how the CLI's own spawn path missed this in 9.2.0.
 */
export function applySecretDefaults<
	TApps extends Record<string, { secrets?: SecretsScopeConfig | false }>,
>(
	apps: TApps,
	defaults: SecretsScopeConfig | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): TApps {
	if (defaults === false) {
		return mapValues(apps, (app) => ({ ...app, secrets: false })) as TApps;
	}

	if (!Object.values(apps).some((app) => app.secrets)) return apps;
	return mapValues(apps, (app) =>
		app.secrets
			? {
					...app,
					secrets: {
						...(resolveScope(app.secrets, defaults, env) ?? app.secrets),
						// Not part of the scope's identity, so resolveScope drops it.
						...(app.secrets.required ? { required: app.secrets.required } : {}),
					},
				}
			: app,
	) as TApps;
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
		readonly [user: string, scope: SecretsScopeConfig | false | undefined]
	>,
	defaults: SecretsScopeConfig | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): CollectedScope[] {
	const scopes = new Map<string, CollectedScope>();
	for (const [user, config] of readers) {
		const scope = resolveScope(config, defaults, env);
		if (!scope) continue;
		const key = scopeKey(scope);
		const known = scopes.get(key);
		if (known) known.usedBy.push(user);
		else scopes.set(key, { scope, usedBy: [user] });
	}
	return [...scopes.values()];
}

/** The keys of `values` the scope lets through (`only`, then `exclude`). */
export function filterScopeKeys(
	scope: InfisicalScope,
	values: Record<string, string>,
): Record<string, string> {
	if (!scope.only && !scope.exclude) return values;
	const only = scope.only && new Set(scope.only);
	const exclude = new Set(scope.exclude);
	return Object.fromEntries(
		Object.entries(values).filter(
			([key]) => (!only || only.has(key)) && !exclude.has(key),
		),
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
		const required = app.secrets ? (app.secrets.required ?? []) : [];
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
