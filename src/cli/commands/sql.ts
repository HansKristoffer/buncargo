import { splitCommandLine } from "../../apple-container/run-plan";
import { containerRuntimeForEnv } from "../../container-runtime";
import {
	type Credentials,
	serviceCredentials,
} from "../../core/service-identity";
import { inferDockerPreset } from "../../core/service-presets";
import { loadDevEnv } from "../../loader";
import type { DockerPresetName, ServiceConfig } from "../../types";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";

const FLAGS = {
	help: {
		name: "--help",
		kind: "boolean",
		description: "Show this help message",
	},
	command: {
		name: "--command",
		kind: "string",
		valueHint: "=<query>",
		description:
			"Run one query and exit (-c); without it, an interactive shell",
	},
	createScratch: {
		name: "--create-scratch",
		kind: "string",
		valueHint: "=<name>",
		description:
			"(Re)create an empty Postgres database scratch_<name> and print its URL",
	},
	dropScratch: {
		name: "--drop-scratch",
		kind: "string",
		valueHint: "=<name>",
		description: "Drop the database scratch_<name>",
	},
	json: {
		name: "--json",
		kind: "boolean",
		description:
			"With --command, print the rows as JSON (Postgres, ClickHouse)",
	},
} as const;

export const SQL_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo sql [<service>] [options]",
	flags: Object.values(FLAGS),
	examples: [
		{
			command: "buncargo sql",
			description: "psql into this checkout's database",
		},
		{
			command: 'buncargo sql -c "select count(*) from users" --json',
			description: "One query, rows as JSON",
		},
		{ command: "buncargo sql redis -c 'GET key'", description: "redis-cli" },
		{
			command:
				"DATABASE_URL=$(buncargo sql --create-scratch=migcheck) bun test",
			description: "A throwaway database in this checkout's Postgres",
		},
	],
};

const SCRATCH_NAME = /^[a-z][a-z0-9_]{0,40}$/;

/**
 * psql argv that drops (and for `create`, recreates) `scratch_<name>`.
 *
 * Always prefixed, so `--drop-scratch` can never reach a database the project
 * uses. Two `-c`s, because `CREATE DATABASE` refuses to run inside the one
 * transaction a single multi-statement `-c` becomes. Recreated on every
 * create: a migration check wants an empty database, not last run's.
 */
export function scratchCommand(
	credentials: Credentials | undefined,
	name: string,
	action: "create" | "drop",
): string[] {
	if (!SCRATCH_NAME.test(name))
		throw new CliError(
			`Scratch database names are lowercase letters, digits and _, starting with a letter: got "${name}".`,
		);
	const { user, password } = credentials ?? {
		user: "postgres",
		password: "postgres",
	};
	const database = `scratch_${name}`;
	return [
		"env",
		`PGPASSWORD=${password}`,
		// "does not exist, skipping" is the expected first run, not news.
		"PGOPTIONS=-c client_min_messages=warning",
		"psql",
		"-X",
		"-q",
		"-U",
		user,
		"-d",
		"postgres",
		"-v",
		"ON_ERROR_STOP=1",
		"-c",
		`drop database if exists ${database} with (force)`,
		...(action === "create" ? ["-c", `create database ${database}`] : []),
	];
}

/** The host-side URL of a scratch database, for the caller's own tools. */
export function scratchUrl(
	credentials: Credentials | undefined,
	port: number,
	name: string,
): string {
	const url = new URL(`postgresql://localhost:${port}/scratch_${name}`);
	url.username = credentials?.user ?? "postgres";
	url.password = credentials?.password ?? "postgres";
	return url.toString();
}

/** Presets picked when no service is named: the SQL databases. */
const DEFAULT_PRESETS: readonly DockerPresetName[] = ["postgres", "clickhouse"];

/**
 * The client argv for one preset, run inside its own container: the client
 * always matches the server, nothing has to be installed on the host, and the
 * credentials come from the config rather than a grep of the compose file.
 */
export function sqlClientCommand(
	preset: DockerPresetName,
	credentials: Credentials | undefined,
	options: { query?: string; json?: boolean },
): string[] {
	const { query, json } = options;
	if (json && query === undefined)
		throw new CliError("--json needs a query: pass --command.");

	switch (preset) {
		case "postgres": {
			const { user, password, database } = credentials ?? {
				user: "postgres",
				password: "postgres",
				database: "postgres",
			};
			const psql = [
				"env",
				`PGPASSWORD=${password}`,
				"psql",
				"-X",
				"-U",
				user,
				"-d",
				database,
			];
			if (query === undefined) return psql;
			const statement = json
				? `select coalesce(json_agg(q), '[]'::json) from (${query.trim().replace(/;+$/, "")}) q`
				: query;
			return [
				...psql,
				"-v",
				"ON_ERROR_STOP=1",
				...(json ? ["-A", "-t"] : []),
				"-c",
				statement,
			];
		}
		case "clickhouse": {
			const client = [
				"clickhouse-client",
				...(credentials
					? [
							"--user",
							credentials.user,
							"--password",
							credentials.password,
							"--database",
							credentials.database,
						]
					: []),
			];
			if (query === undefined) return client;
			return [
				...client,
				"--query",
				query,
				...(json ? ["--format", "JSONEachRow"] : []),
			];
		}
		case "redis":
			if (json) throw new CliError("--json is not supported for redis.");
			return ["redis-cli", ...(query ? splitCommandLine(query) : [])];
		default:
			throw new CliError(`buncargo sql has no client for ${preset} services.`);
	}
}

/** The named service, or the first SQL database in the config. */
function pickService(
	services: Record<string, ServiceConfig>,
	name: string | undefined,
): { name: string; preset: DockerPresetName; service: ServiceConfig } {
	const candidates = Object.entries(services).flatMap(([key, service]) => {
		const preset = inferDockerPreset(key, service);
		return preset ? [{ name: key, preset, service }] : [];
	});
	if (name !== undefined) {
		const found = candidates.find((candidate) => candidate.name === name);
		if (found) return found;
		throw new CliError(
			services[name]
				? `"${name}" is not a built-in database service buncargo has a client for.`
				: `No service named "${name}".`,
			[`Services: ${Object.keys(services).join(", ") || "(none)"}`],
		);
	}
	const found = candidates.find((candidate) =>
		DEFAULT_PRESETS.includes(candidate.preset),
	);
	if (!found)
		throw new CliError("This config has no Postgres or ClickHouse service.", [
			"Name one: buncargo sql <service>",
		]);
	return found;
}

/**
 * `buncargo sql`: the database's own client, inside this checkout's container.
 * Agents used to grep the generated compose file for credentials and `docker
 * exec` into whatever Postgres they found, another worktree's included.
 */
export async function handleSql(rawArgs: string[]): Promise<number> {
	const args = rawArgs.map((arg) => (arg === "-c" ? FLAGS.command.name : arg));
	if (readBooleanFlag(args, FLAGS.help)) {
		console.log(formatCommandHelp(SQL_COMMAND_SPEC));
		return 0;
	}
	const problems: string[] = [];
	const query = readStringFlag(args, FLAGS.command, problems);
	const createScratch = readStringFlag(args, FLAGS.createScratch, problems);
	const dropScratch = readStringFlag(args, FLAGS.dropScratch, problems);
	const scratch = createScratch ?? dropScratch;
	if (createScratch !== undefined && dropScratch !== undefined)
		problems.push("Choose either --create-scratch or --drop-scratch.");
	if (scratch !== undefined && query !== undefined)
		problems.push("--command cannot be combined with a scratch database.");
	const [name, ...extra] = readPositionals(SQL_COMMAND_SPEC, args);
	problems.push(
		...findUnknownFlags(SQL_COMMAND_SPEC, args).map(
			(f) => `Unknown flag: ${f}`,
		),
		...extra.map((arg) => `Unexpected argument: ${arg}`),
	);
	if (problems.length > 0) throw argumentsError(problems, "sql");

	const env = await loadDevEnv({ readOnly: true });
	const target = pickService(env.services, name);
	const credentials = serviceCredentials(target.preset, target.service);
	if (scratch !== undefined && target.preset !== "postgres")
		throw new CliError("Scratch databases are Postgres only.");
	const command =
		scratch === undefined
			? sqlClientCommand(target.preset, credentials, {
					query,
					json: readBooleanFlag(args, FLAGS.json),
				})
			: scratchCommand(
					credentials,
					scratch,
					createScratch !== undefined ? "create" : "drop",
				);
	const argv = await containerRuntimeForEnv(env).interactiveExecArgv({
		projectName: env.projectName,
		serviceName: target.name,
		command,
		root: env.root,
		tty:
			query === undefined &&
			scratch === undefined &&
			Boolean(process.stdin.isTTY && process.stdout.isTTY),
	});
	if (!argv)
		throw new CliError(
			`${target.name} is not running for ${env.projectName}.`,
			["Start it with: buncargo dev --up-only"],
		);

	// A scratch database answers with its URL alone on stdout, so it can be
	// captured: `DATABASE_URL=$(buncargo sql --create-scratch=x) bun test`.
	const child = Bun.spawn(argv, {
		cwd: env.root,
		stdio: ["inherit", scratch === undefined ? "inherit" : "ignore", "inherit"],
	});
	const code = await child.exited;
	const port = (env.ports as Record<string, number | undefined>)[target.name];
	if (code === 0 && createScratch !== undefined && port !== undefined)
		console.log(scratchUrl(credentials, port, createScratch));
	return code;
}
