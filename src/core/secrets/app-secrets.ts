import { startTimer } from "hanzio";
import type { SecretsHolder } from "../../types";
import { secretsEnvironment } from "../runtime-flags";
import { stopsTheRun } from "./auth";
import {
	describeSecretsError,
	fetchScopeSecrets,
	reportScopeOnce,
	warnSecretsOnce,
} from "./fetch";
import {
	collectScopes,
	type InfisicalScope,
	resolveScopes,
	scopeKey,
} from "./scope";

/**
 * Fetch every scope the selected apps name and return each app's own values.
 *
 * Layered scopes on an app are fetched in parallel (deduplicated per folder)
 * and merged strictly in declared order so later scopes override earlier ones.
 *
 * Lowest precedence: keys the developer already exported are dropped here, and
 * the caller layers the computed env on top. Each scope prints one line naming
 * the keys it injects, never a value. A failed scope warns once and yields
 * nothing, leaving that app's own loader to do what it does today; a missing
 * or expired session throws instead.
 */
export async function loadAppSecrets(
	apps: Record<string, SecretsHolder>,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		onWait?: (ms: number) => void;
	} = {},
): Promise<Record<string, Record<string, string>>> {
	const env = options.env ?? process.env;
	// An app that declared nothing is not opted in, whatever the defaults say.
	const appScopes = Object.entries(apps).flatMap(([name, app]) => {
		if (!app.secrets) return [];
		const resolved = resolveScopes(app.secrets, undefined, env);
		return resolved.length > 0 ? [[name, resolved] as const] : [];
	});
	if (appScopes.length === 0) return {};

	const scopes = collectScopes(
		Object.entries(apps).flatMap(([name, app]) =>
			app.secrets ? [[name, app.secrets] as const] : [],
		),
		undefined,
		env,
	);
	if (scopes.length === 0) return {};

	const fetchedByScope = new Map<string, Record<string, string>>();
	const elapsed = startTimer();
	try {
		await Promise.all(
			scopes.map(async ({ scope, usedBy }) => {
				let fetched: Record<string, string> = {};
				try {
					fetched = withoutExported(
						await fetchScopeSecrets(scope, { signal: options.signal, env }),
						env,
					);
					reportInjected(scope, usedBy, Object.keys(fetched), env);
				} catch (error) {
					options.signal?.throwIfAborted();
					// Every app's own loader would wait on the same login.
					if (stopsTheRun(error, env)) throw error;
					warnSecretsOnce(
						scope,
						`Could not load Infisical secrets for ${usedBy.join(", ")}: ${describeSecretsError(error)} Each app will fetch its own.`,
					);
				}
				fetchedByScope.set(scopeKey(scope), fetched);
			}),
		);
	} finally {
		options.onWait?.(elapsed());
	}

	const values: Record<string, Record<string, string>> = {};
	for (const [name, resolved] of appScopes) {
		const merged: Record<string, string> = {};
		for (const scope of resolved) {
			Object.assign(merged, fetchedByScope.get(scopeKey(scope)));
		}
		values[name] = merged;
	}
	return values;
}

/**
 * One line per scope naming what it injects. A key added to the shared
 * Infisical environment reaches every checkout on its next start, and this
 * line is where that shows. A non-`dev` environment the shell picked
 * (`SECRETS_ENV=prod` left over from a deploy) is a warning: a local stack is
 * about to run with that environment's keys.
 */
function reportInjected(
	scope: InfisicalScope,
	usedBy: readonly string[],
	keys: readonly string[],
	env: NodeJS.ProcessEnv,
): void {
	const names = keys.length > 0 ? [...keys].sort().join(", ") : "no keys";
	const path = scope.path === "/" ? "" : scope.path;
	const from = `${scope.projectId} ${scope.environment}${path}`;
	const fromShell =
		scope.environment !== "dev" &&
		secretsEnvironment(env) === scope.environment;
	reportScopeOnce(
		scope,
		fromShell
			? `SECRETS_ENV=${scope.environment} in this shell: ${usedBy.join(", ")} get Infisical ${from}: ${names}. Unset SECRETS_ENV, or set secrets.environment in dev.config.ts.`
			: `Infisical ${from} for ${usedBy.join(", ")}: ${names}`,
		{ warn: fromShell },
	);
}

/** The developer's own exports outrank the project's. */
function withoutExported(
	values: Record<string, string>,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).filter(([name]) => env[name] === undefined),
	);
}

/**
 * Every secret in one scope, for something that runs one command with one
 * scope (migrations, seed, `exec`, tasks). Uses the same authentication and
 * per-scope cache as app processes.
 * Throws when the fetch fails.
 */
export async function loadScopeSecrets(
	scope: InfisicalScope,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		onWait?: (ms: number) => void;
	} = {},
): Promise<Record<string, string>> {
	const env = options.env ?? process.env;
	const elapsed = startTimer();
	try {
		return withoutExported(
			await fetchScopeSecrets(scope, { signal: options.signal, env }),
			env,
		);
	} finally {
		options.onWait?.(elapsed());
	}
}
