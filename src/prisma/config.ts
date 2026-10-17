/** What `prisma` defaults to, for each consumer to read from one place. */
export interface ResolvedPrismaConfig {
	/** Relative to the root. */
	cwd: string;
	/** Relative to {@link cwd}. */
	migrations: string;
	/** The database's service key. */
	service: string;
	urlEnvVar: string;
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
				service?: string;
				urlEnvVar?: string;
		  }
		| undefined,
): ResolvedPrismaConfig {
	return {
		cwd: prisma?.cwd ?? "packages/prisma",
		migrations: prisma?.migrations ?? "prisma/migrations",
		service: prisma?.service ?? "postgres",
		urlEnvVar: prisma?.urlEnvVar ?? "DATABASE_URL",
	};
}
