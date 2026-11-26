import { getErrorMessage } from "hanzio";
import { InfisicalLoginError, SecretsError } from "../../core/secrets/errors";
import {
	type CollectedScope,
	describeScope,
	fetchScopeSecrets,
	isScopeList,
	missingKeys,
	requiredSecretKeys,
	resolveScopes,
} from "../../core/secrets/index";
import { loadDevEnv } from "../../loader";
import type { SecretsScopeInput } from "../../types";
import { BASE_EXITS, defineCommand, defineGroup } from "../command-spec";
import { CliError } from "../errors";
import type { SecretsCheckJson } from "../json-documents";
import * as log from "../log";
import { configSecretScopes } from "../secrets-scopes";

/**
 * `secrets check`'s exit codes, one meaning each. 1 is any failure to run the
 * command itself (arguments, dev.config.ts).
 */
export const SECRETS_CHECK_EXIT = {
	ok: 0,
	/** No usable session on a site: run the printed `infisical login`. */
	login: 2,
	/** Signed in, but a scope could not be read (project, environment, access, network). */
	unreadable: 3,
} as const;

async function listSecrets(
	app: string | undefined,
	environment: string | undefined,
	profile: string | undefined,
): Promise<number> {
	const env = await loadDevEnv(profile !== undefined ? { profile } : undefined);

	if (app !== undefined && !env.apps[app]) {
		const names = Object.keys(env.apps);
		const known =
			names.length > 0
				? `Apps in dev.config.ts: ${names.join(", ")}.`
				: "dev.config.ts has no apps.";
		throw new CliError(`Unknown app "${app}". ${known}`);
	}

	const config = app === undefined ? env.secrets : env.apps[app]?.secrets;
	const overridden =
		config && environment
			? isScopeList(config)
				? config.map((entry, index) =>
						index === 0 || entry.environment === undefined
							? { ...entry, environment }
							: entry,
					)
				: { ...config, environment }
			: config;
	const scopeDefaults =
		app === undefined || environment !== undefined ? undefined : env.secrets;
	const scopes = overridden ? resolveScopes(overridden, scopeDefaults) : [];

	if (scopes.length === 0) {
		throw app === undefined
			? new CliError(
					env.secrets === false
						? "dev.config.ts turns secrets off with secrets: false."
						: "No config-level secrets scope: set secrets.projectId in dev.config.ts.",
				)
			: new CliError(`App "${app}" has no secrets scope.`, [
					noAppScopeFix(app, env.apps[app]?.secrets, env.secrets),
				]);
	}

	// A SecretsError is reported with its fix (`toCliError`). Fetch layers in
	// parallel and merge in declared order so later scopes override earlier ones.
	const layers = await Promise.all(
		scopes.map((scope) => fetchScopeSecrets(scope)),
	);
	const values: Record<string, string> = {};
	for (const layer of layers) Object.assign(values, layer);

	// What the app is given, in `dev`'s precedence: the secrets, then the
	// developer's exported environment, then the computed env.
	const computed: Record<string, string> =
		app === undefined ? env.buildEnvVars() : env.buildAppEnvVars(app);
	const effective = { ...values, ...process.env, ...computed };
	const required = requiredSecretKeys(config);
	const keys = [...new Set([...Object.keys(values), ...required])].sort();
	const width = Math.max(0, ...keys.map((key) => key.length));

	if (scopes.length === 1) {
		log.line(`${app ?? "config"}: ${describeScope(scopes[0])}`);
	} else {
		log.line(`${app ?? "config"}:`);
		for (const scope of scopes) {
			log.line(`  - ${describeScope(scope)}`);
		}
	}
	for (const key of keys) {
		const source = secretSource(key, values, computed, effective);
		log.line(`  ${key.padEnd(width)}  ${source}`);
	}

	// The same check `dev` refuses to start on.
	const missing = missingKeys(required, effective);
	if (missing.length === 0) return 0;
	log.error(`Required secrets are missing: ${missing.join(", ")}`);
	log.hint("Add them to the Infisical scope above, or export them.");
	return 1;
}

const lsCommand = defineCommand({
	spec: {
		name: "secrets ls",
		summary: "Key names and where each comes from, never values",
		flags: {
			app: {
				kind: "string",
				value: "<name>",
				description: "This app's scope instead of the config-level one",
			},
			env: {
				kind: "string",
				value: "<slug>",
				description: "This Infisical environment",
			},
			profile: {
				kind: "string",
				value: "<name>",
				description:
					"Apply a profile's env and secrets overrides (default: the profile named default)",
			},
		},
	},
	exits: { ...BASE_EXITS, 1: "a required secret is missing, or bad arguments" },
	run: ({ values }) => listSecrets(values.app, values.env, values.profile),
});

const checkCommand = defineCommand({
	spec: {
		name: "secrets check",
		summary: "Whether every Infisical scope the config uses is readable",
		flags: {
			json: { kind: "boolean", description: "One JSON document on stdout" },
			profile: {
				kind: "string",
				value: "<name>",
				description:
					"Apply a profile's secrets overrides (default: the profile named default)",
			},
		},
	},
	exits: {
		[SECRETS_CHECK_EXIT.ok]: "every scope is readable",
		1: "the command could not run (arguments, dev.config.ts)",
		[SECRETS_CHECK_EXIT.login]:
			"no usable session on a site: run the printed infisical login",
		[SECRETS_CHECK_EXIT.unreadable]:
			"signed in, but a scope could not be read (project, environment, access, network)",
	},
	json: "SecretsCheckJson (--json)",
	run: ({ values }) => checkSecrets(values.json, values.profile),
});

/**
 * `buncargo secrets ls`: which keys a scope provides and where each value
 * comes from. `buncargo secrets check`: whether every scope the config uses is
 * readable, for an agent to run before tests. Neither prints a value, and
 * there is deliberately no command that does: secret values, production
 * credentials among them, stay out of an agent's context.
 */
export const secretsCommand = defineGroup({
	spec: {
		name: "secrets",
		summary: "List Infisical keys and where each comes from (never values)",
	},
	subcommands: { ls: lsCommand, check: checkCommand },
});

/** Where the value the app gets for `key` comes from, or `missing` when it gets none. */
function secretSource(
	key: string,
	values: Record<string, string>,
	computed: Record<string, string>,
	effective: Record<string, string | undefined>,
): string {
	if (!effective[key]) return "missing";
	if (computed[key] !== undefined) return "computed";
	if (process.env[key] !== undefined) return "env override";
	return values[key] ? "infisical" : "missing";
}

/** What to change in dev.config.ts so `app` has a scope to list. */
function noAppScopeFix(
	app: string,
	own: SecretsScopeInput | false | undefined,
	config: SecretsScopeInput | false | undefined,
): string {
	if (config === false)
		return "dev.config.ts sets secrets: false, which turns secrets off for every app.";
	if (own === false)
		return `dev.config.ts sets apps.${app}.secrets: false; give it a scope instead, such as { projectId: "…" }.`;
	const hasConfigProject = Boolean(
		config && (isScopeList(config) ? config[0]?.projectId : config.projectId),
	);
	if (own === undefined && hasConfigProject)
		return `Add apps.${app}.secrets: {} to dev.config.ts to use the config-level scope, or { projectId: "…" } for its own.`;
	return `Set apps.${app}.secrets.projectId, or secrets.projectId for every app, in dev.config.ts.`;
}

interface ScopeCheck extends CollectedScope {
	/** Keys the scope holds; never their values. */
	keys?: number;
	error?: string;
	fix?: string;
	login: boolean;
}

/** Why a scope could not be read, and its fix. Never a value or the CLI's output. */
function describeFailure(
	error: unknown,
): Pick<ScopeCheck, "error" | "fix" | "login"> {
	if (error instanceof InfisicalLoginError)
		return { error: error.reason, fix: error.login, login: true };
	const fix = error instanceof SecretsError ? error.fix : undefined;
	return {
		error: getErrorMessage(error),
		...(fix ? { fix } : {}),
		login: false,
	};
}

/** `buncargo secrets check [--json] [--profile=<name>]`. */
async function checkSecrets(json: boolean, profile?: string): Promise<number> {
	const env = await loadDevEnv(profile !== undefined ? { profile } : undefined);
	const checks = await Promise.all(
		configSecretScopes(env).map(async (entry): Promise<ScopeCheck> => {
			try {
				const keys = Object.keys(await fetchScopeSecrets(entry.scope)).length;
				return { ...entry, keys, login: false };
			} catch (error) {
				return { ...entry, ...describeFailure(error) };
			}
		}),
	);

	const loginChecks = checks.filter((check) => check.login);
	const logins = [...new Set(loginChecks.flatMap((check) => check.fix ?? []))];
	const unreadable = checks.some((check) => check.error !== undefined);

	let code: number = SECRETS_CHECK_EXIT.ok;
	if (unreadable) code = SECRETS_CHECK_EXIT.unreadable;
	// A login may fix the rest, so it is the one thing to do first.
	if (logins.length > 0) code = SECRETS_CHECK_EXIT.login;

	if (json) {
		const scopes = checks.map(({ scope, usedBy, keys, error, fix }) => ({
			...scope,
			usedBy,
			ok: error === undefined,
			...(keys === undefined ? {} : { keys }),
			...(error === undefined ? {} : { error }),
			...(fix === undefined ? {} : { fix }),
		}));
		const document = {
			ok: code === SECRETS_CHECK_EXIT.ok,
			exitCode: code,
			logins,
			scopes,
		} satisfies SecretsCheckJson;
		log.line(JSON.stringify(document, null, 2));
		return code;
	}

	if (checks.length === 0) {
		log.line("dev.config.ts uses no Infisical scope; nothing to check.");
		return code;
	}

	for (const check of checks) {
		const who = check.usedBy.join(", ");
		if (check.error === undefined) {
			const keyCount = `${check.keys} key${check.keys === 1 ? "" : "s"}`;
			log.success(`${who}: ${describeScope(check.scope)} (${keyCount})`);
			continue;
		}
		log.error(`${who}: ${describeScope(check.scope)}: ${check.error}`);
		if (check.fix && !check.login) log.hint(`Fix: ${check.fix}`);
	}

	for (const login of logins) log.hint(`Log in, then run this again: ${login}`);
	return code;
}
