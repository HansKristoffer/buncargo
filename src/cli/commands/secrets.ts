import { getErrorMessage } from "hanzio";
import { InfisicalLoginError, SecretsError } from "../../core/secrets/errors";
import {
	fetchScopeSecrets,
	missingKeys,
	resolveScope,
} from "../../core/secrets/infisical";
import { loadDevEnv } from "../../loader";
import type { SecretsScopeConfig } from "../../types";
import {
	type CommandSpec,
	type FlagSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import * as log from "../log";
import {
	type ConfigSecretScope,
	configSecretScopes,
	describeScope,
} from "../secrets-scopes";

/**
 * `buncargo secrets ls`: which keys a scope provides and where each value
 * comes from. `buncargo secrets check`: whether every scope the config uses is
 * readable, for an agent to run before tests. Neither prints a value, and
 * there is deliberately no command that does: secret values, production
 * credentials among them, stay out of an agent's context.
 */

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	app: {
		name: "--app",
		kind: "string",
		valueHint: "=<name>",
		description: "This app's scope instead of the config-level one",
		validate: (value: string) => (value ? undefined : "--app requires a name"),
	},
	env: {
		name: "--env",
		kind: "string",
		valueHint: "=<slug>",
		description: "This Infisical environment",
		validate: (value: string) => (value ? undefined : "--env requires a slug"),
	},
	json: {
		name: "--json",
		kind: "boolean",
		description: "check: one JSON document on stdout",
	},
} as const satisfies Record<string, FlagSpec>;

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

export const SECRETS_COMMAND_SPEC: CommandSpec = {
	// One line per subcommand: the `ls` line predates `check` and stays as it was.
	usage: [
		"buncargo secrets ls [--app=<name>] [--env=<slug>]",
		"       buncargo secrets check [--json]",
	].join("\n"),
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "ls",
			description: "Key names and where each comes from, never values",
		},
		{
			command: "check",
			description:
				"Whether every scope is readable; exit 2 needs a login, 3 another fix",
		},
	],
};

export async function handleSecrets(args: string[]): Promise<number> {
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(SECRETS_COMMAND_SPEC));
		return 0;
	}
	const errors: string[] = [];
	const app = readStringFlag(args, FLAGS.app, errors);
	const environment = readStringFlag(args, FLAGS.env, errors);
	const json = readBooleanFlag(args, FLAGS.json);
	const [command, ...extra] = readPositionals(SECRETS_COMMAND_SPEC, args);
	errors.push(
		...findUnknownFlags(SECRETS_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
		...extra.map((arg) => `Unexpected argument: ${arg}`),
	);
	if (command === "check" && (app !== undefined || environment !== undefined))
		errors.push("--app and --env apply to secrets ls.");
	if (command === "ls" && json) errors.push("--json applies to secrets check.");
	if (command !== "ls" && command !== "check") {
		errors.push(
			command
				? `Unknown secrets command: ${command}`
				: "buncargo secrets needs a command: ls or check",
		);
	}
	if (errors.length > 0) throw argumentsError(errors, "secrets");
	if (command === "check") return checkSecrets(json);

	const env = await loadDevEnv({ readOnly: true });
	if (app !== undefined && !env.apps[app]) {
		const names = Object.keys(env.apps);
		throw new CliError(
			`Unknown app "${app}". ${names.length > 0 ? `Apps in dev.config.ts: ${names.join(", ")}.` : "dev.config.ts has no apps."}`,
		);
	}
	const config = app === undefined ? env.secrets : env.apps[app]?.secrets;
	const scope = config
		? resolveScope(
				{ ...config, ...(environment ? { environment } : {}) },
				env.secrets,
			)
		: undefined;
	if (!scope) {
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

	// A SecretsError is reported with its fix (`toCliError`).
	const values = await fetchScopeSecrets(scope);

	// What the app is given, in `dev`'s precedence: the secrets, then the
	// developer's exported environment, then the computed env.
	const computed: Record<string, string> =
		app === undefined ? env.buildEnvVars() : env.buildAppEnvVars(app);
	const effective = { ...values, ...process.env, ...computed };
	const required = config ? (config.required ?? []) : [];
	const keys = [...new Set([...Object.keys(values), ...required])].sort();
	const width = Math.max(0, ...keys.map((key) => key.length));
	log.line(`${app ?? "config"}: ${describeScope(scope)}`);
	for (const key of keys)
		log.line(
			`  ${key.padEnd(width)}  ${secretSource(key, values, computed, effective)}`,
		);
	// The same check `dev` refuses to start on.
	const missing = missingKeys(required, effective);
	if (missing.length === 0) return 0;
	log.error(`Required secrets are missing: ${missing.join(", ")}`);
	log.hint("Add them to the Infisical scope above, or export them.");
	return 1;
}

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
	own: SecretsScopeConfig | false | undefined,
	config: SecretsScopeConfig | false | undefined,
): string {
	if (config === false)
		return "dev.config.ts sets secrets: false, which turns secrets off for every app.";
	if (own === false)
		return `dev.config.ts sets apps.${app}.secrets: false; give it a scope instead, such as { projectId: "…" }.`;
	if (own === undefined && config?.projectId)
		return `Add apps.${app}.secrets: {} to dev.config.ts to use the config-level scope, or { projectId: "…" } for its own.`;
	return `Set apps.${app}.secrets.projectId, or secrets.projectId for every app, in dev.config.ts.`;
}

interface ScopeCheck extends ConfigSecretScope {
	/** Keys the scope holds; never their values. */
	keys?: number;
	error?: string;
	fix?: string;
	login: boolean;
}

/** `buncargo secrets check [--json]`. */
async function checkSecrets(json: boolean): Promise<number> {
	const env = await loadDevEnv({ readOnly: true });
	const checks = await Promise.all(
		configSecretScopes(env).map(async (entry): Promise<ScopeCheck> => {
			try {
				const keys = Object.keys(await fetchScopeSecrets(entry.scope)).length;
				return { ...entry, keys, login: false };
			} catch (error) {
				return {
					...entry,
					// A SecretsError never carries a value or the CLI's output.
					error: getErrorMessage(error),
					...(error instanceof SecretsError && error.fix
						? { fix: error.fix }
						: {}),
					login: error instanceof InfisicalLoginError,
				};
			}
		}),
	);

	const logins = [
		...new Set(checks.flatMap((check) => (check.login && check.fix) || [])),
	];
	const code =
		logins.length > 0
			? SECRETS_CHECK_EXIT.login
			: checks.some((check) => check.error !== undefined)
				? SECRETS_CHECK_EXIT.unreadable
				: SECRETS_CHECK_EXIT.ok;

	if (json) {
		const scopes = checks.map(({ scope, usedBy, keys, error, fix }) => ({
			...scope,
			usedBy,
			ok: error === undefined,
			...(keys === undefined ? {} : { keys }),
			...(error === undefined ? {} : { error }),
			...(fix === undefined ? {} : { fix }),
		}));
		log.line(
			JSON.stringify(
				{ ok: code === SECRETS_CHECK_EXIT.ok, exitCode: code, logins, scopes },
				null,
				2,
			),
		);
		return code;
	}

	if (checks.length === 0) {
		log.line("dev.config.ts uses no Infisical scope; nothing to check.");
		return code;
	}
	for (const check of checks) {
		const who = check.usedBy.join(", ");
		if (check.error === undefined) {
			const keys = `${check.keys} key${check.keys === 1 ? "" : "s"}`;
			log.success(`${who}: ${describeScope(check.scope)} (${keys})`);
			continue;
		}
		log.error(`${who}: ${describeScope(check.scope)}: ${check.error}`);
		if (check.fix && !check.login) log.hint(`Fix: ${check.fix}`);
	}
	for (const login of logins) log.hint(`Log in, then run this again: ${login}`);
	return code;
}
