import {
	collectScopes,
	fetchScopeSecrets,
	type InfisicalScope,
} from "../core/secrets/index";
import type {
	MigrationConfig,
	SecretsHolder,
	SecretsScopeInput,
} from "../types";

export interface StartSecretsSelection {
	apps: Record<string, SecretsHolder>;
	defaults?: SecretsScopeInput | false;
	seed?: SecretsScopeInput | false;
	includeSeed: boolean;
	migrations: MigrationConfig[];
	/** Extra scopes contributed by integrations (e.g. `firebase({ functionsEnv })`). */
	extraScopes?: readonly (readonly [string, SecretsScopeInput])[];
}

/** The distinct scopes a start reads: its apps', the seed's, migrations' and integrations'. */
export function startSecretScopes(
	input: StartSecretsSelection,
): InfisicalScope[] {
	return collectScopes(
		[
			...Object.entries(input.apps).flatMap(([name, app]) =>
				app.secrets ? [[name, app.secrets] as const] : [],
			),
			...(input.includeSeed ? [["seed", input.seed] as const] : []),
			...input.migrations.map(
				(migration) => [migration.name, migration.secrets] as const,
			),
			...(input.extraScopes ?? []),
		],
		input.defaults,
	).map(({ scope }) => scope);
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
