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
 * (migrations, the seed, `exec`) and each app's. What `secrets check`,
 * `doctor` and `dev`'s session check look at.
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
 * The scope a command run for `app` (or for the checkout) reads, as
 * `exec` resolves it: the app's, else the config-level one.
 */
export function commandSecretScopes(
	env: SecretsConfig,
	app: string | undefined,
): InfisicalScope[] {
	const config = app === undefined ? env.secrets : env.apps[app]?.secrets;
	const scope = config ? resolveScope(config, env.secrets) : undefined;
	return scope ? [scope] : [];
}

/** `project env/path @ site`, the way `secrets` prints a scope. */
export function describeScope(scope: InfisicalScope): string {
	const path = scope.path === "/" ? "" : scope.path;
	const org = scope.organizationId ? ` org ${scope.organizationId}` : "";
	return `${scope.projectId} ${scope.environment}${path} @ ${scope.siteUrl}${org}`;
}
