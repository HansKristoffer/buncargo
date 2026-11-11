/** What `prisma` defaults to, for each consumer to read from one place. */
export interface ResolvedPrismaConfig {
	/** Relative to the root. */
	cwd: string;
	/** Relative to {@link cwd}. */
	migrations: string;
	/** Relative to {@link cwd}. */
	schema: string;
	/** The database's service key. */
	service: string;
	/** Where Prisma reads the database URL: the first of {@link urlEnvVars}. */
	urlEnvVar: string;
	/** Every variable set to the checkout's database URL; never empty. */
	urlEnvVars: readonly string[];
}

/**
 * `prisma` with its defaults applied. Without a `prisma` key the defaults
 * still name the database a seed check reads.
 */
export function resolvePrismaConfig(
	prisma:
		| {
				cwd?: string;
				migrations?: string;
				schema?: string;
				service?: string;
				urlEnvVar?: string | readonly string[];
		  }
		| undefined,
): ResolvedPrismaConfig {
	const named = prisma?.urlEnvVar ?? "DATABASE_URL";
	const urlEnvVars = typeof named === "string" ? [named] : named;
	const [urlEnvVar = "DATABASE_URL"] = urlEnvVars;
	return {
		cwd: prisma?.cwd ?? "packages/prisma",
		migrations: prisma?.migrations ?? "prisma/migrations",
		schema: prisma?.schema ?? "prisma/schema.prisma",
		service: prisma?.service ?? "postgres",
		urlEnvVar,
		urlEnvVars: urlEnvVars.length > 0 ? urlEnvVars : [urlEnvVar],
	};
}
