import { resolve } from "node:path";
import { typedSwitch } from "hanzio";
import { splitCommandLine } from "../../apple-container/run-plan";
import { containerRuntimeForEnv } from "../../container-runtime";
import { CommandSignalError } from "../../core/process";
import { isInteractive } from "../../core/prompt";
import {
	type Credentials,
	postgresCredentials,
} from "../../core/service-identity";
import { loadDevEnv } from "../../loader";
import type {
	AnyDevEnvironment,
	DockerPresetName,
	ResolvedService,
} from "../../types";
import {
	type CommandSpec,
	findUnknownFlags,
	formatCommandHelp,
	readBooleanFlag,
	readPositionals,
	readStringFlag,
} from "../command-spec";
import { argumentsError, CliError } from "../errors";
import { splitCliArgs } from "../flags";
import { assertDatabaseName, databaseUrl } from "./database-url";
import { planJsonQuery, unwrapJsonErrors } from "./sql-statements";

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
	db: {
		name: "--db",
		kind: "string",
		valueHint: "=<database>",
		description:
			"Use another database of this checkout's Postgres, as it is (e.g. scratch_<name>)",
	},
	url: {
		name: "--url",
		kind: "boolean",
		description: "Print the Postgres database's URL instead of connecting",
	},
} as const;

export const SQL_COMMAND_SPEC: CommandSpec = {
	usage: "buncargo sql [<service>] [options]",
	flags: Object.values(FLAGS),
	notes: [
		{
			command: "-- <args>",
			description:
				"Passed to the client (psql -tA, -v ON_ERROR_STOP=0, -f <host file>)",
		},
		{
			command: "stdin",
			description:
				"Without -c, SQL piped or in a heredoc runs as a script; it stops at the first error",
		},
	],
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
		{
			command: "buncargo sql --db=scratch_migcheck -- -tA -f query.sql",
			description: "A file against an existing database, psql flags after --",
		},
		{
			command: "buncargo sql <<'SQL' ... SQL",
			description: "A script from a heredoc",
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
	credentials: Credentials,
	name: string,
	action: "create" | "drop",
): string[] {
	if (!SCRATCH_NAME.test(name))
		throw new CliError(
			`Scratch database names are lowercase letters, digits and _, starting with a letter: got "${name}".`,
		);
	const database = `scratch_${name}`;
	return [
		"env",
		`PGPASSWORD=${credentials.password}`,
		// "does not exist, skipping" is the expected first run, not news.
		"PGOPTIONS=-c client_min_messages=warning",
		"psql",
		"-X",
		"-q",
		"-U",
		credentials.user,
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
	credentials: Credentials,
	port: number,
	name: string,
): string {
	return databaseUrl(credentials, port, `scratch_${name}`);
}

/** Presets picked when no service is named: the SQL databases. */
const DEFAULT_PRESETS: readonly DockerPresetName[] = ["postgres", "clickhouse"];
const PRESET_LABELS: Partial<Record<DockerPresetName, string>> = {
	postgres: "Postgres",
	clickhouse: "ClickHouse",
};

/**
 * SQL for the client: one `-c` query, or a script on its stdin. A script's
 * `bytes` are fed as they are (a host file); without them the client reads
 * the caller's own stdin, unread. `text` is there only when `--json` had to
 * read the script to decide whether to wrap it.
 */
export type SqlInput =
	| { kind: "query"; text: string }
	| { kind: "script"; bytes?: Uint8Array; text?: string };

export interface SqlClientInvocation {
	/** Argv inside the service's container. */
	command: string[];
	/** Bytes for the client's stdin; inherited when undefined. */
	stdin?: Uint8Array;
	/** `--json` wrapped the query in `json_agg`. */
	jsonWrapped: boolean;
	/** Why `--json` ran the SQL plain instead. */
	plainReason?: string;
}

/**
 * The client argv for one preset, run inside its own container: the client
 * always matches the server, nothing has to be installed on the host, and the
 * credentials come from the config rather than a grep of the compose file.
 */
export function sqlClientCommand(
	preset: DockerPresetName,
	credentials: Credentials | undefined,
	options: {
		input?: SqlInput;
		json?: boolean;
		/** Postgres: another database than the service's own. */
		database?: string;
		/** Arguments after `--`, for the client. */
		clientArgs?: readonly string[];
	},
): SqlClientInvocation {
	const { input, json = false, clientArgs = [] } = options;
	if (json && input === undefined)
		throw new CliError(
			"--json needs SQL: pass --command, -- -f <file>, or pipe it on stdin.",
		);
	const script = input?.kind === "script" ? input : undefined;

	return typedSwitch(
		preset,
		{
			postgres: () => {
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
					options.database ?? database,
				];
				if (input === undefined)
					return { command: [...psql, ...clientArgs], jsonWrapped: false };

				const plan =
					json && input.text !== undefined
						? planJsonQuery(input.text)
						: undefined;
				const stopOnError = ["-v", "ON_ERROR_STOP=1"];
				if (plan?.wrap)
					return {
						command: [
							...psql,
							...stopOnError,
							"-A",
							"-t",
							...clientArgs,
							"-c",
							plan.statement,
						],
						jsonWrapped: true,
					};

				const plainReason = plan?.wrap === false ? plan.reason : undefined;
				// `-f -` rather than a bare stdin: psql then names the line of
				// an error (`psql:<stdin>:3: ERROR`).
				const source =
					input.kind === "query" ? ["-c", input.text] : ["-f", "-"];
				return {
					command: [...psql, ...stopOnError, ...clientArgs, ...source],
					stdin: script?.bytes,
					jsonWrapped: false,
					plainReason,
				};
			},
			clickhouse: () => {
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
				const query = input?.kind === "query" ? ["--query", input.text] : [];
				const format = json ? ["--format", "JSONEachRow"] : [];
				return {
					command: [...client, ...query, ...format, ...clientArgs],
					stdin: script?.bytes,
					jsonWrapped: false,
				};
			},
			redis: () => {
				if (json) throw new CliError("--json is not supported for redis.");
				const words =
					input?.kind === "query" ? splitCommandLine(input.text) : [];
				return {
					command: ["redis-cli", ...clientArgs, ...words],
					stdin: script?.bytes,
					jsonWrapped: false,
				};
			},
		},
		(other) => {
			throw new CliError(`buncargo sql has no client for ${other} services.`);
		},
	);
}

/**
 * Pull psql's `-f <file>` out of the client arguments: psql runs in the
 * container and cannot see a host path, so the files are read here and fed
 * on its stdin instead. `-f -` is stdin itself.
 */
export function extractScriptFiles(clientArgs: readonly string[]): {
	files: string[];
	rest: string[];
} {
	const files: string[] = [];
	const rest: string[] = [];
	for (let index = 0; index < clientArgs.length; index++) {
		const arg = clientArgs[index] as string;
		const next = clientArgs[index + 1];
		const separate = (arg === "-f" || arg === "--file") && next !== undefined;
		if (separate) {
			files.push(next);
			index++;
		} else if (arg.startsWith("--file=")) {
			files.push(arg.slice("--file=".length));
		} else if (arg.startsWith("-f") && arg.length > 2 && arg[2] !== "-") {
			files.push(arg.slice(2));
		} else {
			rest.push(arg);
		}
	}
	return { files, rest };
}

/** psql short options that take a value: the rest of their group is it. */
const PSQL_VALUE_OPTIONS = new Set("cdfFhLopPRTUv");
/** psql short options that do their own work instead of reading a script. */
const PSQL_OWN_WORK = new Set("clV?");

/**
 * Client arguments that give psql its own work (`-c`, `-l`, `--version`), so
 * stdin is left to it rather than run as a script. Short options may be
 * grouped (`-lqt`, `-tAc "…"`).
 */
export function psqlHasOwnInput(clientArgs: readonly string[]): boolean {
	return clientArgs.some((arg) => {
		const long = ["--command", "--list", "--help", "--version"];
		if (arg.startsWith("--"))
			return long.some((name) => arg === name || arg.startsWith(`${name}=`));
		if (!arg.startsWith("-")) return false;
		for (const letter of arg.slice(1)) {
			if (PSQL_OWN_WORK.has(letter)) return true;
			if (PSQL_VALUE_OPTIONS.has(letter)) return false;
		}
		return false;
	});
}

/**
 * The named service, or the config's first service of one of `presets`:
 * `--db` in a config that lists ClickHouse first means its Postgres.
 */
function pickService(
	services: Record<string, ResolvedService>,
	name: string | undefined,
	presets: readonly DockerPresetName[],
): { name: string; preset: DockerPresetName; service: ResolvedService } {
	const candidates = Object.entries(services).flatMap(([key, service]) => {
		const { preset } = service;
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
		presets.includes(candidate.preset),
	);
	if (!found) {
		const wanted = presets
			.map((preset) => PRESET_LABELS[preset] ?? preset)
			.join(" or ");
		throw new CliError(`This config has no ${wanted} service.`, [
			"Name one: buncargo sql <service>",
		]);
	}
	return found;
}

/**
 * What to say when the service has no running container. `dev --up-only`
 * already returns once the containers are up and leaves them running, so it
 * needs no `--detach`, which it refuses.
 */
export function notRunningError(
	service: string,
	projectName: string,
	preset: DockerPresetName,
): CliError {
	const hints = [
		"Start the containers (it returns once they are up; no --detach): buncargo dev --up-only",
	];
	if (preset === "postgres")
		hints.push(
			`Or start only ${service} with a fresh database: buncargo sql --create-scratch=<name>`,
		);
	return new CliError(`${service} is not running for ${projectName}.`, hints);
}

interface SqlRequest {
	service?: string;
	query?: string;
	json: boolean;
	createScratch?: string;
	dropScratch?: string;
	db?: string;
	url: boolean;
	clientArgs: string[];
}

function parseSqlArgs(rawArgs: string[]): SqlRequest | "help" {
	const { flags: ownArgs, passthrough } = splitCliArgs(rawArgs);
	const args = ownArgs.map((arg) => (arg === "-c" ? FLAGS.command.name : arg));
	if (readBooleanFlag(args, FLAGS.help)) return "help";

	const problems: string[] = [];
	const query = readStringFlag(args, FLAGS.command, problems);
	const createScratch = readStringFlag(args, FLAGS.createScratch, problems);
	const dropScratch = readStringFlag(args, FLAGS.dropScratch, problems);
	const db = readStringFlag(args, FLAGS.db, problems);
	const url = readBooleanFlag(args, FLAGS.url);
	const scratch = createScratch ?? dropScratch;
	if (createScratch !== undefined && dropScratch !== undefined)
		problems.push("Choose either --create-scratch or --drop-scratch.");
	if (scratch !== undefined && (query !== undefined || db !== undefined))
		problems.push(
			"--command and --db cannot be combined with a scratch database.",
		);
	if (scratch !== undefined && passthrough.length > 0)
		problems.push(
			"Arguments after -- cannot be combined with a scratch database.",
		);
	const runsSomething =
		query !== undefined || dropScratch !== undefined || passthrough.length > 0;
	if (url && runsSomething)
		problems.push(
			"--url prints a URL and runs nothing: drop --command, --drop-scratch and arguments after --.",
		);
	const [service, ...extra] = readPositionals(SQL_COMMAND_SPEC, args);
	problems.push(
		...findUnknownFlags(SQL_COMMAND_SPEC, args).map(
			(f) => `Unknown flag: ${f}`,
		),
		...extra.map((arg) => `Unexpected argument: ${arg}`),
	);
	if (problems.length > 0) throw argumentsError(problems, "sql");

	return {
		service,
		query,
		json: readBooleanFlag(args, FLAGS.json),
		createScratch,
		dropScratch,
		db,
		url,
		clientArgs: passthrough,
	};
}

/** What `buncargo sql` reaches outside itself. */
export interface SqlDeps {
	loadEnv(readOnly: boolean): Promise<AnyDevEnvironment>;
	/** The argv into the service's container, or undefined when it is not running. */
	execArgv(
		env: AnyDevEnvironment,
		request: { serviceName: string; command: string[]; tty: boolean },
	): Promise<string[] | undefined>;
	/** Start one service, claimed like `dev --up-only` and held the same way. */
	startService(env: AnyDevEnvironment, serviceName: string): Promise<void>;
	stdinIsTerminal(): boolean;
	/** All of stdin; only called when it is not a terminal. */
	readStdin(): Promise<Uint8Array>;
	readFile(path: string): Promise<Uint8Array>;
	isInteractive(): boolean;
	spawn(
		argv: string[],
		io: {
			cwd: string;
			stdin?: Uint8Array;
			stdout: "inherit" | "ignore";
			/** Hand stderr to this instead of the terminal. */
			onStderr?: (text: string) => void;
		},
	): Promise<number>;
	print(line: string): void;
	warn(line: string): void;
}

async function readScriptFile(
	deps: SqlDeps,
	file: string,
): Promise<Uint8Array> {
	if (file === "-") return deps.readStdin();
	const path = resolve(file);
	try {
		return await deps.readFile(path);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new CliError(`Could not read ${path}: ${reason}`, [
			"-f reads a file on this machine, relative to the current directory.",
		]);
	}
}

/**
 * Where the SQL comes from. Stdin is read only when `--json` needs the text
 * to decide whether to wrap it; otherwise psql reads it unread, byte for
 * byte, however large. Host files are fed as bytes. Clients other than psql
 * get their arguments and stdin as they are.
 */
async function resolveInput(
	request: SqlRequest,
	preset: DockerPresetName,
	deps: SqlDeps,
): Promise<{ input?: SqlInput; clientArgs: string[] }> {
	const psql = preset === "postgres";
	const { files, rest } = psql
		? extractScriptFiles(request.clientArgs)
		: { files: [], rest: request.clientArgs };
	if (request.query !== undefined && files.length > 0)
		throw argumentsError(
			["Pass SQL one way: --command or -f, not both."],
			"sql",
		);
	if (request.query !== undefined)
		return { input: { kind: "query", text: request.query }, clientArgs: rest };

	const decode = (bytes: Uint8Array) =>
		request.json ? new TextDecoder().decode(bytes) : undefined;
	const stdinOnly = files.length === 1 && files[0] === "-";
	if (files.length > 0 && !(stdinOnly && !request.json)) {
		const parts: Uint8Array[] = [];
		for (const file of files) parts.push(await readScriptFile(deps, file));
		const bytes = Buffer.concat(parts);
		return {
			input: { kind: "script", bytes, text: decode(bytes) },
			clientArgs: rest,
		};
	}
	if (stdinOnly) return { input: { kind: "script" }, clientArgs: rest };

	const ownInput = psql ? psqlHasOwnInput(rest) : rest.length > 0;
	if (ownInput || deps.stdinIsTerminal()) return { clientArgs: rest };
	if (!(psql && request.json))
		return { input: { kind: "script" }, clientArgs: rest };
	const bytes = await deps.readStdin();
	return {
		input: { kind: "script", bytes, text: decode(bytes) },
		clientArgs: rest,
	};
}

/**
 * `buncargo sql`: the database's own client, inside this checkout's container.
 * Agents used to grep the generated compose file for credentials and `docker
 * exec` into whatever Postgres they found, another worktree's included.
 */
export async function runSql(
	rawArgs: string[],
	deps: SqlDeps,
): Promise<number> {
	const request = parseSqlArgs(rawArgs);
	if (request === "help") {
		deps.print(formatCommandHelp(SQL_COMMAND_SPEC));
		return 0;
	}
	const { createScratch, dropScratch, db } = request;
	const scratch = createScratch ?? dropScratch;
	if (db !== undefined) assertDatabaseName(db, "--db");

	let env = await deps.loadEnv(true);
	const postgresOnly = scratch !== undefined || db !== undefined || request.url;
	const target = pickService(
		env.services,
		request.service,
		postgresOnly ? ["postgres"] : DEFAULT_PRESETS,
	);
	if (postgresOnly && target.preset !== "postgres")
		throw new CliError(
			`Scratch databases, --db and --url are Postgres only, and ${target.name} is ${target.preset}.`,
			["Name a Postgres service: buncargo sql <service> …"],
		);
	const portOf = (current: AnyDevEnvironment) =>
		(current.ports as Record<string, number | undefined>)[target.name];

	if (request.url && createScratch === undefined) {
		const credentials = postgresCredentials(target.service);
		const port = portOf(env);
		if (port === undefined)
			throw new CliError(`${target.name} has no port in ${env.projectName}.`, [
				"Give the service a port in dev.config.ts, as service.postgres() does.",
			]);
		deps.print(databaseUrl(credentials, port, db ?? credentials.database));
		return 0;
	}

	const { input, clientArgs } =
		scratch === undefined
			? await resolveInput(request, target.preset, deps)
			: { clientArgs: [] };
	const invocation =
		scratch === undefined
			? sqlClientCommand(target.preset, target.service.credentials, {
					input,
					json: request.json,
					database: db,
					clientArgs,
				})
			: {
					command: scratchCommand(
						postgresCredentials(target.service),
						scratch,
						createScratch !== undefined ? "create" : "drop",
					),
					jsonWrapped: false,
				};
	if (invocation.plainReason)
		deps.warn(
			`--json prints the rows of one SELECT or WITH query; this SQL ${invocation.plainReason}, so it ran as plain SQL.`,
		);

	const execRequest = {
		serviceName: target.name,
		command: invocation.command,
		tty: input === undefined && scratch === undefined && deps.isInteractive(),
	};
	let argv = await deps.execArgv(env, execRequest);
	// A scratch database is for a command about to run against it: start the
	// one service it lives in, as `dev --up-only` would, rather than send the
	// caller off to start the whole stack.
	if (!argv && createScratch !== undefined) {
		env = await deps.loadEnv(false);
		await deps.startService(env, target.name);
		argv = await deps.execArgv(env, execRequest);
	}
	if (!argv) throw notRunningError(target.name, env.projectName, target.preset);

	// A scratch database answers with its URL alone on stdout, so it can be
	// captured: `DATABASE_URL=$(buncargo sql --create-scratch=x) bun test`.
	const code = await deps.spawn(argv, {
		cwd: env.root,
		stdin: invocation.stdin,
		stdout: scratch === undefined ? "inherit" : "ignore",
		onStderr: invocation.jsonWrapped
			? (text) => deps.warn(unwrapJsonErrors(text).trimEnd())
			: undefined,
	});
	const port = portOf(env);
	if (code === 0 && createScratch !== undefined && port !== undefined)
		deps.print(
			scratchUrl(postgresCredentials(target.service), port, createScratch),
		);
	return code;
}

/**
 * Start one service outside `dev`, with the claim `dev --up-only` makes: the
 * block is allocated first, the run is claimed before the container exists,
 * and released with no idle hold, so the service stays up for the command
 * that uses it. Ctrl-C cancels the start and still releases the claim, so
 * the sweep never reads a half-started service as a crash.
 */
async function startOneService(
	env: AnyDevEnvironment,
	serviceName: string,
): Promise<void> {
	const controller = new AbortController();
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	const cancel = (signal: NodeJS.Signals) =>
		controller.abort(new CommandSignalError(signal));
	for (const signal of signals) process.on(signal, cancel);
	const { signal } = controller;

	console.error(`Starting ${serviceName} for ${env.projectName}…`);
	try {
		await env.prepareStartAsync(undefined, [serviceName], signal);
		await env.claimRun({ idleTimeoutMs: false, signal });
		await env.start({
			onlyServices: [serviceName],
			startServers: false,
			prepare: "containers",
			skipEnvironmentLog: true,
			// stdout carries the URL alone.
			verbose: false,
			signal,
		});
	} finally {
		await env.releaseRun();
		for (const name of signals) process.off(name, cancel);
	}
}

const PRODUCTION_SQL_DEPS: SqlDeps = {
	loadEnv: (readOnly) => loadDevEnv({ readOnly }),
	execArgv: (env, request) =>
		containerRuntimeForEnv(env).interactiveExecArgv({
			projectName: env.projectName,
			root: env.root,
			...request,
		}),
	startService: startOneService,
	stdinIsTerminal: () => Boolean(process.stdin.isTTY),
	readStdin: async () => new Uint8Array(await Bun.stdin.arrayBuffer()),
	readFile: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
	isInteractive,
	spawn: async (argv, io) => {
		const child = Bun.spawn(argv, {
			cwd: io.cwd,
			stdin: io.stdin ?? "inherit",
			stdout: io.stdout,
			stderr: io.onStderr ? "pipe" : "inherit",
		});
		const stderr = io.onStderr ? await new Response(child.stderr).text() : "";
		const code = await child.exited;
		if (stderr) io.onStderr?.(stderr);
		return code;
	},
	print: (line) => console.log(line),
	warn: (line) => console.error(line),
};

export function handleSql(rawArgs: string[]): Promise<number> {
	return runSql(rawArgs, PRODUCTION_SQL_DEPS);
}
