import { selectReactiveTasks } from "../core/process";
import { resolvePrismaConfig } from "../prisma/config";
import { migrationsFor } from "../prisma/migrations-for";
import type {
	AnyDevConfig,
	MigrationConfig,
	ResolvedApp,
	ResolvedService,
	SecretsScopeInput,
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
	 * The seed step runs: the seed's services (and `afterApps`, when set) are
	 * selected (any service, for a seed that names none, or for no seed, whose
	 * step then says so).
	 */
	readonly seedSelected: boolean;
	/** The seed runs beside the apps rather than before them. */
	readonly seedOverlaps: boolean;
	/** Prerequisite apps that must be ready before the seed runs (`seed.afterApps`). */
	readonly seedAfterApps: readonly string[] | undefined;
	/**
	 * `seed.afterApps` this selection does not start (a profile or `--apps`
	 * left them out): the seed is skipped, and the run says so.
	 */
	readonly seedMissingApps: readonly string[];
	/** When `seedAfterApps` is set, whether remaining apps wait for the seed. */
	readonly seedBeforeOtherApps: boolean;
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
	/** Checkout root, for integrations whose secret scopes fall back to `.infisical.json`. */
	readonly root?: string;
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
		| "prisma"
		| "migrations"
		| "seed"
		| "hooks"
		| "secrets"
		| "integrations"
		| "tasks"
	>,
	services: Readonly<Record<string, ResolvedService>>,
	input: PreparationInput,
	options: PreparationOptions,
): PreparationPlan {
	const selected = input.requiredServiceKeys;
	const anySelected = selected.length > 0;

	// A step with no `requiredServices` runs whenever any service is selected.
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

	const afterApps =
		config.seed?.afterApps && config.seed.afterApps.length > 0
			? config.seed.afterApps
			: undefined;
	const hasAfterApps = afterApps !== undefined;
	const seedMissingApps = (afterApps ?? []).filter(
		(name) => !(name in input.apps),
	);
	const appsSatisfied = seedMissingApps.length === 0;
	const servicesSatisfied = hasAfterApps
		? config.seed?.requiredServices !== undefined
			? config.seed.requiredServices.every((name) => selected.includes(name))
			: true
		: prepared(config.seed?.requiredServices);

	const appCount = Object.keys(input.apps).length;
	const seedSelected = hasAfterApps
		? appsSatisfied && servicesSatisfied && options.spawn && appCount > 0
		: servicesSatisfied;
	const seedAfterApps = hasAfterApps && seedSelected ? afterApps : undefined;
	const seedBeforeOtherApps = config.seed?.beforeApps !== false;
	const seedOverlaps =
		!hasAfterApps &&
		options.seed === "auto" &&
		options.spawn &&
		appCount > 0 &&
		seedCanOverlap(config.seed, services, selected);

	// Containers-only mode brings every selected service up at once.
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

	const selectedAppNames = Object.keys(input.apps);
	const integrationSecretScopes =
		options.prepare === "all"
			? (config.integrations ?? []).flatMap((integration) =>
					(
						integration.secretScopes?.({
							selectedApps: selectedAppNames,
							root: input.root,
							defaults: config.secrets,
						}) ?? []
					).map((scope) => [integration.name, scope] as const),
				)
			: [];
	const startableAppNames = Object.entries(input.apps)
		.filter(([, app]) => app.devCommand !== false)
		.map(([name]) => name);
	const reactiveTasks =
		options.prepare === "all" && options.spawn
			? selectReactiveTasks(
					config.tasks,
					new Set(startableAppNames),
					new Set(selected),
				)
			: {};
	const taskSecretScopes: (readonly [string, SecretsScopeInput])[] =
		config.secrets &&
		Object.values(reactiveTasks).some((task) => task.app === undefined)
			? [["tasks", config.secrets]]
			: [];
	const extraScopes = [...integrationSecretScopes, ...taskSecretScopes];

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
		seedAfterApps,
		seedMissingApps,
		seedBeforeOtherApps,
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
					...(extraScopes.length > 0 ? { extraScopes } : {}),
				},
	};
}

/**
 * The line a start prints when it skips the seed because its selection
 * (`selectedApps`) leaves out apps `seed.afterApps` waits for: the
 * selection with them added is the one that seeds.
 */
export function seedSkippedLine(
	missingApps: readonly string[],
	selectedApps: readonly string[],
): string {
	const plural = missingApps.length === 1 ? "" : "s";
	const names = missingApps.join(", ");
	const withMissing = [...selectedApps, ...missingApps].join(",");
	return `Seed skipped: seed.afterApps waits for app${plural} ${names}, which this run does not start. To seed, run \`buncargo dev --seed --apps=${withMissing}\`, or \`buncargo dev --seed\` without --apps or --profile.`;
}
