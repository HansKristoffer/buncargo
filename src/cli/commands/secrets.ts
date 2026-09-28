import {
	fetchScopeSecrets,
	resolveScope,
	SecretsError,
} from "../../core/secrets/infisical";
import { loadDevEnv } from "../../loader";
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

/**
 * `buncargo secrets ls`: which keys a scope provides and where each value
 * comes from. Never prints a value. Whether every scope is readable at all is
 * `setup`'s and `doctor`'s Infisical check.
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
} as const satisfies Record<string, FlagSpec>;

export const SECRETS_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo secrets ls [--app=<name>] [--env=<slug>]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "ls",
			description: "Key names and where each comes from, never values",
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
	const [command, ...extra] = readPositionals(SECRETS_COMMAND_SPEC, args);
	errors.push(
		...findUnknownFlags(SECRETS_COMMAND_SPEC, args).map(
			(flag) => `Unknown flag: ${flag}`,
		),
		...extra.map((arg) => `Unexpected argument: ${arg}`),
	);
	if (command !== "ls") {
		errors.push(
			command
				? `Unknown secrets command: ${command}`
				: "buncargo secrets needs a command: ls",
		);
	}
	if (errors.length > 0) throw argumentsError(errors, "secrets");

	const env = await loadDevEnv({ readOnly: true });
	if (app !== undefined && !env.apps[app]) {
		throw new CliError(`Unknown app "${app}".`);
	}
	const config = app === undefined ? env.secrets : env.apps[app]?.secrets;
	const scope = config
		? resolveScope(
				{ ...config, ...(environment ? { environment } : {}) },
				env.secrets,
			)
		: undefined;
	if (!scope) {
		throw new CliError(
			app === undefined
				? "No config-level secrets scope: set secrets.projectId in dev.config.ts."
				: `App "${app}" has no secrets scope.`,
		);
	}

	let values: Record<string, string>;
	try {
		values = await fetchScopeSecrets(scope);
	} catch (error) {
		if (error instanceof SecretsError) {
			throw new CliError(error.message, error.fix ? [`Fix: ${error.fix}`] : []);
		}
		throw error;
	}

	const required = config?.required ?? [];
	const keys = [...new Set([...Object.keys(values), ...required])].sort();
	const width = Math.max(0, ...keys.map((key) => key.length));
	const org = scope.organizationId ? ` org ${scope.organizationId}` : "";
	log.line(
		`${app ?? "config"}: ${scope.projectId} ${scope.environment}${scope.path === "/" ? "" : scope.path} @ ${scope.siteUrl}${org}`,
	);
	for (const key of keys) {
		const source =
			process.env[key] !== undefined
				? "env override"
				: values[key]
					? "infisical"
					: "missing";
		log.line(`  ${key.padEnd(width)}  ${source}`);
	}
	// A required key nobody provides is the failure `dev` would stop on.
	return required.some((key) => !values[key] && process.env[key] === undefined)
		? 1
		: 0;
}
