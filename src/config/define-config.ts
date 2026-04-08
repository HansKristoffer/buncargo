import type {
	AppConfig,
	DevConfig,
	DevHooks,
	DevOptions,
	DockerComposeGenerationOptions,
	EnvVarsBuilder,
	MigrationConfig,
	PrismaConfig,
	SeedConfig,
	ServiceConfig,
	TypedAppDefinitions,
} from "../types";

export function defineDevConfig<
	const TServices extends Record<string, ServiceConfig>,
	const TApps extends Record<string, AppConfig> = Record<string, never>,
>(config: {
	projectPrefix: string;
	services: TServices;
	apps?: TApps & TypedAppDefinitions<TServices, TApps>;
	envVars?: EnvVarsBuilder<TServices, TypedAppDefinitions<TServices, TApps>>;
	hooks?: DevHooks<TServices, TypedAppDefinitions<TServices, TApps>>;
	migrations?: MigrationConfig[];
	seed?: SeedConfig<TServices, TypedAppDefinitions<TServices, TApps>>;
	prisma?: PrismaConfig;
	options?: DevOptions;
	docker?: DockerComposeGenerationOptions;
}): DevConfig<TServices, TypedAppDefinitions<TServices, TApps>> {
	return config as DevConfig<TServices, TypedAppDefinitions<TServices, TApps>>;
}
