import {
	fetchScopeSecrets,
	resolveScope,
	scopeKey,
} from "../core/secrets/infisical";
import type { AppConfig, MigrationConfig, SecretsScopeConfig } from "../types";

/** Fire early; consumers own warnings and await the same cached promises. */
export function prefetchSecrets(input: {
	apps: Record<string, AppConfig>;
	defaults?: SecretsScopeConfig;
	seed?: SecretsScopeConfig | false;
	includeSeed: boolean;
	migrations: MigrationConfig[];
	signal?: AbortSignal;
}): Promise<unknown>[] {
	const scopes = new Map<
		string,
		NonNullable<ReturnType<typeof resolveScope>>
	>();
	const add = (scope: SecretsScopeConfig | false | undefined) => {
		if (scope === false) return;
		const resolved = resolveScope(scope, input.defaults);
		if (resolved) scopes.set(scopeKey(resolved), resolved);
	};
	for (const app of Object.values(input.apps))
		if (app.secrets) add(app.secrets);
	if (input.includeSeed) add(input.seed);
	for (const migration of input.migrations) add(migration.secrets);
	return [...scopes.values()].map((scope) => {
		const pending = fetchScopeSecrets(scope, { signal: input.signal });
		void pending.catch(() => {});
		return pending;
	});
}
