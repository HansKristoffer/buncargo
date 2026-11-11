const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** `host:port` of a Postgres URL, loopback names as one; never its credentials. */
function serverOf(value: string): string | undefined {
	if (!/^postgres(ql)?:\/\//.test(value) || !URL.canParse(value)) return;
	const url = new URL(value);
	const host = LOOPBACK.has(url.hostname) ? "localhost" : url.hostname;
	return `${host}:${url.port || "5432"}`;
}

/** A variable Prisma may read that points at another database server. */
export interface ForeignDatabaseUrl {
	name: string;
	/** `host:port` only: safe to print. */
	server: string;
}

/**
 * The variables in `vars` holding a Postgres URL on another server than
 * `target`'s. A `prisma.config.ts` that reads one (a direct URL inherited
 * from the shell) sends Prisma there whatever buncargo set `DATABASE_URL` to.
 */
export function foreignDatabaseUrls(
	vars: Readonly<Record<string, string | undefined>>,
	target: string,
): ForeignDatabaseUrl[] {
	const own = serverOf(target);
	const foreign: ForeignDatabaseUrl[] = [];
	for (const [name, value] of Object.entries(vars)) {
		const server = value === undefined ? undefined : serverOf(value);
		if (server !== undefined && server !== own) foreign.push({ name, server });
	}
	return foreign.sort((a, b) => a.name.localeCompare(b.name));
}

/** Where `url` points, for a banner: `host:port/database`, no credentials. */
export function describeDatabaseUrl(url: string): string {
	if (!URL.canParse(url)) return "an unparseable URL";
	const parsed = new URL(url);
	return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}
