import {
	type CollectedScope,
	collectScopes,
	type InfisicalScope,
	resolveScopes,
} from "../core/secrets/index";
import type {
	BuncargoIntegration,
	IntegrationAdds,
	SecretsHolder,
	SecretsScopeInput,
} from "../types";

/** The part of an environment that names Infisical scopes. */
interface SecretsConfig {
	readonly root?: string;
	readonly secrets?: SecretsScopeInput | false;
	readonly apps: Readonly<Record<string, SecretsHolder>>;
	readonly integrations?: readonly BuncargoIntegration<IntegrationAdds>[];
}

/**
 * Every Infisical scope dev.config.ts names, distinct: the config-level one
 * (migrations, the seed, `exec`), each app's, and any integration scopes.
 * What `secrets check` and `doctor` read; `dev` passes only its selected apps.
 */
export function configSecretScopes(env: SecretsConfig): CollectedScope[] {
	const appNames = Object.keys(env.apps);
	const integrationScopes = (env.integrations ?? []).flatMap((integration) =>
		(
			integration.secretScopes?.({
				selectedApps: appNames,
				root: env.root,
				defaults: env.secrets,
			}) ?? []
		).map((scope) => [integration.name, scope] as const),
	);
	return collectScopes(
		[
			["config", env.secrets],
			...Object.entries(env.apps).flatMap(([name, app]) =>
				app.secrets ? [[name, app.secrets] as const] : [],
			),
			...integrationScopes,
		],
		env.secrets,
	);
}

/**
 * The scopes a command reads, as `exec` resolves them: for an app, the app's
 * own `secrets` (none when it has none); for the checkout, the config-level
 * ones. An unknown app has none here; the command itself reports it.
 */
export function commandSecretScopes(
	env: SecretsConfig,
	app: string | undefined,
): InfisicalScope[] {
	let config = env.secrets;
	if (app !== undefined) {
		config = Object.hasOwn(env.apps, app) ? env.apps[app].secrets : undefined;
	}

	return config ? resolveScopes(config, env.secrets) : [];
}
