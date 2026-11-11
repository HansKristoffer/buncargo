import { join, relative } from "node:path";
import { CommandSignalError, shellExitCode } from "../../core/process/exec";
import { isInteractive } from "../../core/prompt";
import { isCI } from "../../core/runtime-flags";
import { WATCHDOG_IDLE_TIMEOUT_MS } from "../../core/watchdog-constants";
import type { AnyDevEnvironment, PrismaRunner } from "../../types";
import {
	BASE_EXITS,
	type CommandSpec,
	defineCommand,
	formatCommandHelp,
	type Parsed,
	type ParseResult,
	parseArgs,
} from "../command-spec";
import { CliError } from "../errors";
import * as log from "../log";
import { loadEnv } from "./load-env";

const MIGRATION_NEW_SPEC = {
	name: "prisma migration new",
	summary:
		"Write a migration from schema.prisma, after the newest one, and print its path",
	flags: {
		empty: {
			kind: "boolean",
			description: "An empty migration to write by hand",
		},
	},
	args: [
		{ name: "<name>", description: "The migration's name", required: true },
	],
} as const;

const MIGRATION_CHECK_SPEC = {
	name: "prisma migration check",
	summary:
		"Fail when a migration's timestamp collides or sorts before the base branch's newest",
	flags: {
		base: {
			kind: "string",
			value: "<ref>",
			description: "The branch to compare with (default: origin's default)",
		},
	},
} as const;

const MIGRATE_CHECK_SPEC = {
	name: "prisma migrate-check",
	summary: "Fail when migrations and schema.prisma differ",
	flags: {
		migrations: {
			kind: "string",
			value: "<dir>",
			description: "The migrations directory",
		},
		schema: { kind: "string", value: "<path>", description: "The schema file" },
	},
	passthrough: "Arguments for prisma migrate diff",
} as const;

type Request =
	| { kind: "prisma"; args: string[] }
	| { kind: "migration new"; name: string; empty: boolean }
	| { kind: "migration check"; base: string | undefined }
	| {
			kind: "migrate-check";
			migrations: string | undefined;
			schema: string | undefined;
			args: string[];
	  };

/** A buncargo subcommand's argv, or `undefined` after printing its help. */
function subcommandArgs<const S extends Parameters<typeof parseArgs>[0]>(
	spec: S,
	argv: readonly string[],
): Exclude<ParseResult<S>, { help: true }> | undefined {
	const parsed = parseArgs(spec, argv);
	if (!parsed.help) return parsed as Exclude<ParseResult<S>, { help: true }>;
	console.log(formatCommandHelp({ spec, exits: BASE_EXITS }));
	return undefined;
}

/**
 * What `prisma <args>` asks for, parsed before the config loads so a typo is
 * not answered with a config error. `undefined` once a subcommand's help is
 * printed.
 */
function prismaRequest(args: readonly string[]): Request | undefined {
	const [first, second, ...rest] = args;
	if (first === "migrate-check") {
		const parsed = subcommandArgs(MIGRATE_CHECK_SPEC, args.slice(1));
		return (
			parsed && {
				kind: "migrate-check",
				migrations: parsed.values.migrations,
				schema: parsed.values.schema,
				args: [...parsed.passthrough],
			}
		);
	}
	if (first !== "migration") return { kind: "prisma", args: [...args] };
	if (second === "new") {
		const parsed = subcommandArgs(MIGRATION_NEW_SPEC, rest);
		return (
			parsed && {
				kind: "migration new",
				name: parsed.positionals[0],
				empty: parsed.values.empty,
			}
		);
	}
	if (second === "check") {
		const parsed = subcommandArgs(MIGRATION_CHECK_SPEC, rest);
		return parsed && { kind: "migration check", base: parsed.values.base };
	}
	throw new CliError(
		second === undefined
			? "prisma migration needs new or check."
			: `Unknown prisma migration command: ${second}`,
		[
			"Usage: buncargo prisma migration new <name> [--empty]",
			"       buncargo prisma migration check [--base=<ref>]",
		],
	);
}

const PRISMA_SPEC = {
	name: "prisma",
	usage: "prisma <args>",
	summary: "Run Prisma CLI with correct DATABASE_URL",
	flags: {
		yes: {
			kind: "boolean",
			description:
				"Run a destructive action (migrate reset, db push --force-reset) without a terminal",
		},
		db: {
			kind: "string",
			value: "<name>",
			description:
				"Point Prisma at another database of this checkout's Postgres, e.g. scratch_<name>",
		},
	},
	forwardUnknown: true,
	notes: [
		{ command: "<args>", description: "Prisma's own arguments, unchanged" },
		{
			command: "migration new <name>",
			description: MIGRATION_NEW_SPEC.summary,
		},
		{ command: "migration check", description: MIGRATION_CHECK_SPEC.summary },
		{ command: "migrate-check", description: MIGRATE_CHECK_SPEC.summary },
	],
	examples: [
		{
			command: "bunx buncargo prisma studio",
			description: "Open Prisma Studio",
		},
		{
			command: "bunx buncargo prisma migration new add_users",
			description: "Write a migration without a terminal",
		},
	],
} as const satisfies CommandSpec;

export const prismaCommand = defineCommand({
	spec: PRISMA_SPEC,
	exits: {
		...BASE_EXITS,
		1: "Prisma failed, a check failed, or bad arguments; Prisma's own code otherwise",
		4: "the database applied migrations this branch lacks (a squashed chain)",
	},
	// Exits as soon as Prisma does: the claimed database is released by then,
	// and nothing else of this process is left to finish.
	run: async (parsed) => process.exit(await runPrisma(parsed)),
});

async function runPrisma({
	values,
	positionals,
}: Parsed<typeof PRISMA_SPEC>): Promise<number> {
	const request = prismaRequest(positionals);
	if (!request) return 0;
	if (request.kind.startsWith("migration") && values.db !== undefined)
		throw new CliError("--db cannot be combined with prisma migration.");
	const args = request.kind === "prisma" ? request.args : [];
	const { destructivePrismaAction } = await import("../../prisma");
	refuseDestructivePrisma(destructivePrismaAction(args), args, {
		yes: values.yes,
		interactive: isInteractive(),
		ci: isCI(),
		// What a scratch database holds is the caller's own throwaway.
		scratch: values.db?.startsWith("scratch_") ?? false,
	});
	const env = await loadEnv({ readOnly: request.kind === "migration check" });

	if (!env.prisma) {
		throw new CliError("Prisma is not configured in your dev config.", [
			"Add prisma to your config:",
			"",
			"export default defineDevConfig({",
			"  ...",
			"  prisma: { cwd: 'packages/prisma' }",
			"})",
		]);
	}
	const { prisma } = env;
	if (request.kind === "prisma" && args.length === 0) return prisma.run(args);
	if (request.kind === "migration check")
		return checkMigrationChain(env.root, prisma, request.base);

	return withClaimedDatabase(env, prisma.service, async () => {
		if (request.kind === "migrate-check")
			return prisma.migrateCheck({
				migrations: request.migrations,
				schema: request.schema,
				args: request.args,
			});
		if (request.kind === "migration new")
			return createMigration(prisma, request.name, request.empty);
		if (values.db === undefined) return prisma.run(args);
		const { databaseExists, databaseOverrides } =
			await import("./exec-database");
		const overrides = await databaseOverrides(env, undefined, values.db, {
			exists: databaseExists,
			inherited: process.env,
		});
		return prisma.run(args, { env: overrides });
	});
}

/** Print the new migration's path, alone on stdout. */
async function createMigration(
	prisma: PrismaRunner,
	name: string,
	empty: boolean,
): Promise<number> {
	const result = await prisma.newMigration(name, { empty });
	if (result.status === "failed") return result.exitCode;
	if (result.status === "unchanged") {
		console.error(
			"❌ The schema has nothing the migrations lack, so no migration was written. Pass --empty for one you write by hand.",
		);
		return 1;
	}
	console.error("✅ Wrote the migration:");
	log.line(result.path);
	return 0;
}

/**
 * Fail when two migrations share a timestamp, or one the base branch lacks
 * sorts before the base's newest: parallel branches produce both, and a
 * database at the base's tip would skip or misorder them.
 */
async function checkMigrationChain(
	root: string,
	prisma: PrismaRunner,
	requestedBase: string | undefined,
): Promise<number> {
	const {
		defaultBaseRef,
		listMigrationFolders,
		migrationChainProblems,
		migrationFoldersAtRef,
	} = await import("../../prisma");
	const dir = join(root, prisma.cwd, prisma.migrations);
	const local = await listMigrationFolders(dir);
	if (local.length === 0) {
		console.error(`✅ No migrations in ${relative(root, dir)}.`);
		return 0;
	}
	const base = requestedBase ?? defaultBaseRef(dir);
	if (base === undefined)
		throw new CliError("Found no base branch to compare the migrations with.", [
			"Name one: buncargo prisma migration check --base=<ref>",
		]);
	const onBase = migrationFoldersAtRef(dir, base);
	if (onBase === undefined)
		throw new CliError(`git cannot read ${base}.`, [
			"Fetch it, or name another: buncargo prisma migration check --base=<ref>",
		]);
	const problems = migrationChainProblems(local, onBase, base);
	if (problems.length === 0) {
		console.error(
			`✅ ${local.length} migration${local.length === 1 ? "" : "s"} in order with ${base}.`,
		);
		return 0;
	}
	for (const problem of problems) console.error(`❌ ${problem}`);
	console.error(
		"   Rename the folder with a timestamp after the newest on the base branch (prisma migration new picks one).",
	);
	return 1;
}

/**
 * Refuse a destructive Prisma action without a terminal unless `--yes`, as
 * `dev --reset` does: an agent "fixing" a migration with `migrate reset` wipes
 * the developer's database. CI is exempt; its databases are disposable.
 */
function refuseDestructivePrisma(
	action: string | undefined,
	args: readonly string[],
	context: {
		yes: boolean;
		interactive: boolean;
		ci: boolean;
		scratch: boolean;
	},
): void {
	const asked =
		context.yes || context.interactive || context.ci || context.scratch;
	if (action === undefined || asked) return;
	throw new CliError(`${action}. Refusing without a terminal.`, [
		`Pass --yes if that is really what you want: buncargo prisma ${args.join(" ")} --yes`,
	]);
}

/**
 * Run `use` with the database claimed and started, as `buncargo run` does for
 * a task's services: the claim comes before the container, so `ls`, `stop`
 * and BuncargoBar see the run and the sweep leaves the database up while
 * `prisma studio` uses it. Released on the way out, Ctrl-C included, into the
 * hold a `dev` run gets.
 */
async function withClaimedDatabase(
	env: AnyDevEnvironment,
	service: string,
	use: () => Promise<number>,
): Promise<number> {
	const controller = new AbortController();
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
	// The terminal's Ctrl-C reaches Prisma itself; this process only has to
	// live long enough to release.
	const cancel = (signal: NodeJS.Signals) =>
		controller.abort(new CommandSignalError(signal));
	for (const name of signals) process.on(name, cancel);
	const { signal } = controller;

	console.error(`Starting ${service} for ${env.projectName}…`);
	try {
		return await env.withServices(
			[service],
			// stdout is Prisma's alone.
			{
				claim: { defaultIdleTimeoutMs: WATCHDOG_IDLE_TIMEOUT_MS },
				verbose: false,
				signal,
			},
			use,
		);
	} catch (error) {
		if (error instanceof CommandSignalError)
			return shellExitCode(null, error.signal);
		throw error;
	} finally {
		for (const name of signals) process.off(name, cancel);
	}
}
