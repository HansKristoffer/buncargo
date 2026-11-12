import type { AnyDevConfig, MigrationConfig } from "../types";
import { resolvePrismaConfig } from "./config";

/** The command that applies the Prisma migrations, in `prisma.cwd`. */
export const PRISMA_MIGRATE_DEPLOY = "bunx --no-install prisma migrate deploy";

/**
 * Every migration the config declares, in the order they run: `prisma
 * migrate deploy` when `prisma` is configured, then `migrations`. The Prisma
 * one requires the Prisma database's service, so a selection that leaves the
 * database out leaves it out too.
 */
export function migrationsFor(
	config: Pick<AnyDevConfig, "prisma" | "migrations">,
): MigrationConfig[] {
	const prisma = config.prisma && resolvePrismaConfig(config.prisma);
	const prismaMigration: MigrationConfig[] = prisma
		? [
				{
					name: "prisma",
					command: PRISMA_MIGRATE_DEPLOY,
					cwd: prisma.cwd,
					requiredServices: [prisma.service],
				},
			]
		: [];
	return [...prismaMigration, ...(config.migrations ?? [])];
}
