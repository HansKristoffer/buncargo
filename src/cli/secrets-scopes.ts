import {
	type CollectedScope,
	collectScopes,
	type InfisicalScope,
	resolveScope,
} from "../core/secrets/index";
import type { AppConfig, SecretsScopeConfig } from "../types";

/** The part of an environment that names Infisical scopes. */
interface SecretsConfig {
	readonly secrets?: SecretsScopeConfig | false;
	readonly apps: Readonly<Record<string, AppConfig>>;
}

/**
 * Every Infisical scope dev.config.ts names, distinct: the config-level one
 * (migrations, the seed, `exec`) and each app's. What `secrets check` and
 * `doctor` read; `dev` passes only its selected apps.
 */
export function configSecretScopes(env: SecretsConfig): CollectedScope[] {
	return collectScopes(
		[
			["config", env.secrets],
			...Object.entries(env.apps).flatMap(([name, app]) =>
				app.secrets ? [[name, app.secrets] as const] : [],
			),
		],
		env.secrets,
	);
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
