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
	],
};

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
	const command = sqlClientCommand(
		target.preset,
		serviceCredentials(target.preset, target.service),
		{ query, json: readBooleanFlag(args, FLAGS.json) },
	);
	const argv = await containerRuntimeForEnv(env).interactiveExecArgv({
		projectName: env.projectName,
		serviceName: target.name,
		command,
		root: env.root,
		tty:
			query === undefined &&
			Boolean(process.stdin.isTTY && process.stdout.isTTY),
	});
	if (!argv)
		throw new CliError(
			`${target.name} is not running for ${env.projectName}.`,
			["Start it with: buncargo dev --up-only"],
		);

	const child = Bun.spawn(argv, {
		cwd: env.root,
		stdio: ["inherit", "inherit", "inherit"],
	});
	return await child.exited;
}
