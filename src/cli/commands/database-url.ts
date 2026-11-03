import type { Credentials } from "../../core/service-identity";
import { inferDockerPreset } from "../../core/service-presets";
import type { ServiceConfig } from "../../types";
import { CliError } from "../errors";

/**
 * Database names `sql --db` and `exec --db` take. They reach psql as one argv
 * entry and a URL path, never SQL, but a value with `=` or `://` would make
 * psql read it as a connection string.
 */
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

export function assertDatabaseName(name: string, flag: string): void {
	if (DATABASE_NAME.test(name)) return;
	throw new CliError(
		`${flag} takes a database name (letters, digits, _, $ and -, starting with a letter or _): got "${name}".`,
	);
}

/** The host-side URL of one database in this checkout's Postgres. */
export function databaseUrl(
	credentials: Credentials | undefined,
	port: number,
	database: string,
): string {
	const url = new URL(`postgresql://localhost:${port}`);
	url.username = credentials?.user ?? "postgres";
	url.password = credentials?.password ?? "postgres";
	url.pathname = `/${encodeURIComponent(database)}`;
	return url.toString();
}

/** The first service built on the Postgres preset, for `exec --db`. */
export function findPostgresService(
	services: Record<string, ServiceConfig>,
): { name: string; service: ServiceConfig } | undefined {
	for (const [name, service] of Object.entries(services))
		if (inferDockerPreset(name, service) === "postgres")
			return { name, service };
	return undefined;
}

export interface DatabaseTarget {
	/** Hostnames that reach the service from this machine. */
	hosts: ReadonlySet<string>;
	port: number;
	database: string;
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function databaseTarget(
	port: number,
	database: string,
	serviceUrl: string | undefined,
): DatabaseTarget {
	const hosts = new Set(LOOPBACK_HOSTS);
	if (serviceUrl !== undefined && URL.canParse(serviceUrl))
		hosts.add(new URL(serviceUrl).hostname);
	return { hosts, port, database };
}

function pointsAt(value: string, target: DatabaseTarget): URL | undefined {
	if (!/^postgres(ql)?:\/\//.test(value) || !URL.canParse(value)) return;
	const url = new URL(value);
	const samePlace =
		target.hosts.has(url.hostname) && url.port === String(target.port);
	const database = decodeURIComponent(url.pathname.slice(1));
	return samePlace && database === target.database ? url : undefined;
}

/**
 * Every variable whose URL points at `target`'s database, pointed at `name`
 * instead: user, password and query string (`?schema=`) stay as they were. A
 * URL to another database on the same server (a Prisma shadow database)
 * keeps its own.
 */
export function pointEnvAtDatabase(
	env: Readonly<Record<string, string | undefined>>,
	target: DatabaseTarget,
	name: string,
): Record<string, string> {
	const rewritten: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		const url = value === undefined ? undefined : pointsAt(value, target);
		if (!url) continue;
		url.pathname = `/${encodeURIComponent(name)}`;
		rewritten[key] = url.toString();
	}
	return rewritten;
}
