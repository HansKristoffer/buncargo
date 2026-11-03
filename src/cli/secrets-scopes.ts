import {
	type InfisicalScope,
	resolveScope,
	scopeKey,
} from "../core/secrets/infisical";
import type { AppConfig, SecretsScopeConfig } from "../types";

/** The part of an environment that names Infisical scopes. */
interface SecretsConfig {
	readonly secrets?: SecretsScopeConfig | false;
	readonly apps: Readonly<Record<string, AppConfig>>;
}

/** One distinct scope and who reads it: `config`, or an app's name. */
export interface ConfigSecretScope {
	scope: InfisicalScope;
	usedBy: string[];
}

/**
 * Every Infisical scope dev.config.ts names, distinct: the config-level one
 * (migrations, the seed, `exec`) and each app's. What `secrets check` and
 * `doctor` read; `dev` passes only its selected apps.
 */
export function configSecretScopes(env: SecretsConfig): ConfigSecretScope[] {
	const scopes = new Map<string, ConfigSecretScope>();
	const add = (
		user: string,
		config: SecretsScopeConfig | false | undefined,
	) => {
		const scope = config ? resolveScope(config, env.secrets) : undefined;
		if (!scope) return;
		const key = scopeKey(scope);
		const known = scopes.get(key);
		if (known) known.usedBy.push(user);
		else scopes.set(key, { scope, usedBy: [user] });
	};

	add("config", env.secrets);
	for (const [name, app] of Object.entries(env.apps)) add(name, app.secrets);
	return [...scopes.values()];
}

/**
 * The scope a command reads, as `exec` resolves it: for an app, the app's own
 * `secrets` (none when it has none); for the checkout, the config-level one.
 * An unknown app has none here; the command itself reports it.
 */
export function commandSecretScopes(
	env: SecretsConfig,
	app: string | undefined,
): InfisicalScope[] {
	let config = env.secrets;
	if (app !== undefined)
		config = Object.hasOwn(env.apps, app) ? env.apps[app].secrets : undefined;
	const scope = config ? resolveScope(config, env.secrets) : undefined;
	return scope ? [scope] : [];
}

/** `project env/path @ site`, the way `secrets` prints a scope. */
export function describeScope(scope: InfisicalScope): string {
	const path = scope.path === "/" ? "" : scope.path;
	const org = scope.organizationId ? ` org ${scope.organizationId}` : "";
	return `${scope.projectId} ${scope.environment}${path} @ ${scope.siteUrl}${org}`;
}
