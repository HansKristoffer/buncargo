import { resolvePrismaConfig } from "../prisma/config";
import { migrationsFor } from "../prisma/migrations-for";
import type {
	AnyDevConfig,
	MigrationConfig,
	ResolvedApp,
	ResolvedService,
	StartOptions,
} from "../types";
import type { StartSecretsSelection } from "./prefetch-secrets";
import { seedCanOverlap } from "./seed-startup";

/** `prisma db push` in place of `migrate deploy`, for a throwaway database. */
export const PRISMA_DB_PUSH = "bunx --no-install prisma db push";

/** What a start's preparation does for one selection, decided before any of it runs. */
export interface PreparationPlan {
	/** In the order they run: Prisma's first, then `migrations`, each whose services are selected. */
	readonly migrations: MigrationConfig[];
	/** The Prisma database is selected: it gets its migration and generation. */
	readonly prismaSelected: boolean;
	readonly beforeMigrations: boolean;
	/** `afterContainersReady` runs: the selection brings up a service. */
	readonly afterContainersReady: boolean;
	/**
	 * The seed step runs: the seed's services are selected (any service, for a
	 * seed that names none, or for no seed, whose step then says so).
	 */
	readonly seedSelected: boolean;
	/** The seed runs beside the apps rather than before them. */
	readonly seedOverlaps: boolean;
	/** Up before the migrations; in containers-only mode, every selected service. */
	readonly earlyServices: Record<string, ResolvedService>;
	/** `afterPreparation` services: up once the migrations and the seed are done. */
	readonly lateServices: Record<string, ResolvedService>;
	/** The Infisical scopes the preparation and the apps read; none in containers-only mode. */
	readonly secrets: StartSecretsSelection | undefined;
}

export interface PreparationInput {
	readonly requiredServiceKeys: readonly string[];
	/** The apps the start spawns. */
	readonly apps: Record<string, ResolvedApp>;
}

export interface PreparationOptions {
	readonly prepare: NonNullable<StartOptions["prepare"]>;
	readonly seed: NonNullable<StartOptions["seed"]>;
	readonly schema: NonNullable<StartOptions["schema"]>;
	/** Apps are spawned once preparation is done. */
	readonly spawn: boolean;
}

/**
 * Which preparation steps a selection gets. Omitted prerequisites prepare
 * whenever any service is selected; an explicit empty list opts into
 * preparation for app-only selections.
 */
export function planPreparation(
	config: Pick<
		AnyDevConfig,
		"prisma" | "migrations" | "seed" | "hooks" | "secrets"
	>,
	services: Readonly<Record<string, ResolvedService>>,
	input: PreparationInput,
	options: PreparationOptions,
): PreparationPlan {
	const selected = input.requiredServiceKeys;
	const anySelected = selected.length > 0;
	const prepared = (prerequisites?: readonly string[]) =>
		prerequisites
			? prerequisites.every((name) => selected.includes(name))
			: anySelected;

	const prismaSelected =
		config.prisma !== undefined &&
		selected.includes(resolvePrismaConfig(config.prisma).service);
	const push = options.schema === "push";
	const migrations = migrationsFor(config)
		.filter((migration) => prepared(migration.requiredServices))
		.map((migration) =>
			push && migration.name === "prisma"
				? { ...migration, command: PRISMA_DB_PUSH }
				: migration,
		);

	const seedSelected = prepared(config.seed?.requiredServices);
	const appCount = Object.keys(input.apps).length;
	const seedOverlaps =
		options.seed === "auto" &&
		options.spawn &&
		appCount > 0 &&
		seedCanOverlap(config.seed, services, selected);

	const containersOnly = options.prepare === "containers";
	const targets = selected.map((key) => [key, services[key]] as const);
	const earlyServices = Object.fromEntries(
		targets.filter(
			([, service]) => containersOnly || !service.afterPreparation,
		),
	);
	const lateServices = containersOnly
		? {}
		: Object.fromEntries(
				targets.filter(([, service]) => service.afterPreparation),
			);

	return {
		migrations,
		prismaSelected,
		beforeMigrations:
			config.hooks?.beforeMigrations !== undefined &&
			(config.prisma ? prismaSelected : anySelected),
		afterContainersReady:
			config.hooks?.afterContainersReady !== undefined && anySelected,
		seedSelected,
		seedOverlaps,
		earlyServices,
		lateServices,
		secrets: containersOnly
			? undefined
			: {
					apps: options.prepare === "all" ? input.apps : {},
					defaults: config.secrets,
					seed: config.seed?.secrets,
					includeSeed:
						options.prepare === "all" &&
						options.seed !== "skip" &&
						config.seed !== undefined &&
						seedSelected,
					migrations,
				},
	};
}
