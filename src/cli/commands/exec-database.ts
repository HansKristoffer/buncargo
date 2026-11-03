import { withDeadline, withSignal } from "../../core/deadline";
import { serviceCredentials } from "../../core/service-identity";
import type { AnyDevEnvironment } from "../../types";
import { CliError } from "../errors";
import {
	assertDatabaseName,
	databaseTarget,
	databaseUrl,
	findPostgresService,
	pointEnvAtDatabase,
} from "./database-url";

/**
 * Whether `name` exists on the server `url` reaches; undefined when the
 * server cannot be asked (not running, refused the login).
 */
export async function databaseExists(
	url: string,
	name: string,
): Promise<boolean | undefined> {
	try {
		return await withDeadline(async (signal) => {
			const { SQL } = await import("bun");
			const sql = new SQL(url, { max: 1, connectionTimeout: 2 });
			try {
				const rows = await withSignal(
					sql`select 1 from pg_database where datname = ${name}`.execute(),
					signal,
				);
				return rows.length > 0;
			} finally {
				await sql.close({ timeout: 0 });
			}
		}, 3000);
	} catch {
		return undefined;
	}
}

/** What `exec --db` reaches outside itself. */
export interface ExecDatabaseDeps {
	exists(url: string, name: string): Promise<boolean | undefined>;
	/** The variables the command would see before the rewrite. */
	inherited: Readonly<Record<string, string | undefined>>;
}

/**
 * The variables `exec --db=<name>` overrides: every one whose URL points at
 * this checkout's Postgres database, pointed at `name`. Refuses a database
 * that does not exist, and a config where nothing would change, rather than
 * run the command against the checkout's own database.
 */
export async function databaseOverrides(
	env: AnyDevEnvironment,
	app: string | undefined,
	name: string,
	deps: ExecDatabaseDeps,
): Promise<Record<string, string>> {
	assertDatabaseName(name, "--db");
	const postgres = findPostgresService(env.services);
	if (!postgres)
		throw new CliError(
			"--db needs a Postgres service, and this config has none.",
		);
	const port = (env.ports as Record<string, number | undefined>)[postgres.name];
	if (port === undefined)
		throw new CliError(`${postgres.name} has no port in ${env.projectName}.`);
	const credentials = serviceCredentials("postgres", postgres.service);
	const ownDatabase = credentials?.database ?? "postgres";

	const exists = await deps.exists(
		databaseUrl(credentials, port, ownDatabase),
		name,
	);
	if (exists === undefined)
		throw new CliError(
			`Could not reach ${postgres.name} for ${env.projectName} on port ${port} to find database "${name}".`,
			[
				"Start it: buncargo sql --create-scratch=<name>, or buncargo dev --up-only",
			],
		);
	if (!exists) {
		const scratch = name.startsWith("scratch_")
			? name.slice("scratch_".length)
			: undefined;
		const create =
			scratch === undefined
				? `Create one: buncargo sql --create-scratch=<name>, then pass --db=scratch_<name>`
				: `Create it: buncargo sql --create-scratch=${scratch}`;
		throw new CliError(
			`Database "${name}" does not exist in ${postgres.name} (port ${port}).`,
			[create, `List them: buncargo sql -c '\\l'`],
		);
	}

	const knownApp = app !== undefined && app in env.apps;
	const computed: Record<string, string> = knownApp
		? env.buildAppEnvVars(app)
		: env.buildEnvVars();
	const serviceUrl = (env.urls as Record<string, string | undefined>)[
		postgres.name
	];
	const overrides = pointEnvAtDatabase(
		{ ...deps.inherited, ...computed },
		databaseTarget(port, ownDatabase, serviceUrl),
		name,
	);
	if (Object.keys(overrides).length === 0)
		throw new CliError(
			`No variable points at ${postgres.name}'s database "${ownDatabase}" on port ${port}, so --db=${name} would change nothing.`,
			["See the variables: buncargo env"],
		);
	return overrides;
}
