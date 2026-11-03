import {
	fetchScopeSecrets,
	type InfisicalScope,
	resolveScope,
	scopeKey,
} from "../core/secrets/infisical";
import type { AppConfig, MigrationConfig, SecretsScopeConfig } from "../types";

export interface StartSecretsSelection {
	apps: Record<string, AppConfig>;
	defaults?: SecretsScopeConfig | false;
	seed?: SecretsScopeConfig | false;
	includeSeed: boolean;
	migrations: MigrationConfig[];
}

/** The distinct scopes a start reads: its apps', the seed's and the migrations'. */
export function startSecretScopes(
	input: StartSecretsSelection,
): InfisicalScope[] {
	const scopes = new Map<string, InfisicalScope>();
	const add = (scope: SecretsScopeConfig | false | undefined) => {
		if (scope === false) return;
		const resolved = resolveScope(scope, input.defaults);
		if (resolved) scopes.set(scopeKey(resolved), resolved);
	};
	for (const app of Object.values(input.apps))
		if (app.secrets) add(app.secrets);
	if (input.includeSeed) add(input.seed);
	for (const migration of input.migrations) add(migration.secrets);
	return [...scopes.values()];
}

/** Fire early; consumers own warnings and await the same cached promises. */
export function prefetchSecrets(
	input: StartSecretsSelection & { signal?: AbortSignal },
): Promise<unknown>[] {
	return startSecretScopes(input).map((scope) => {
		const pending = fetchScopeSecrets(scope, { signal: input.signal });
		void pending.catch(() => {});
		return pending;
	});
}
