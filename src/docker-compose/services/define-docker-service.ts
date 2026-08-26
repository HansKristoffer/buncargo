import type {
	BuiltInHealthCheck,
	DockerComposeServiceRaw,
	DockerPresetName,
	DockerPresetServiceDefinition,
	ServiceConfig,
} from "../../types";

export interface DockerServiceFactoryInput {
	serviceKey: string;
	config: ServiceConfig;
}

export interface DockerServiceFactoryOutput {
	service: DockerComposeServiceRaw;
	volume?: string;
}

export type DockerServiceFactory = (
	input: DockerServiceFactoryInput,
) => DockerServiceFactoryOutput;

/** Options every built-in preset helper accepts. */
export type PresetServiceSharedOptions = Pick<
	ServiceConfig,
	"serviceName" | "expose"
> & {
	/** Base host port, before the project offset is applied */
	port?: number;
	/** Override the preset's health check, or `false` to skip it */
	healthCheck?: BuiltInHealthCheck | false;
	/** Raw Compose fields merged into the generated service */
	docker?: DockerComposeServiceRaw;
};

/** Adds the credentials that presets with a connection URL interpolate into it. */
export type PresetServiceCredentialOptions = PresetServiceSharedOptions &
	Pick<ServiceConfig, "database" | "user" | "password">;

/** Adds the second host port for presets that bind two. */
export type PresetServiceSecondaryPortOptions = PresetServiceSharedOptions & {
	secondaryPort?: number;
};

/**
 * The preset-independent part of a service config, with `env` already narrowed
 * to the preset's own env map. `enhanceServiceConfig` receives this and adds
 * whatever else its preset understands.
 */
export type PresetServiceConfigBase<TServiceConfig extends ServiceConfig> =
	Omit<ServiceConfig, "env"> & Partial<Pick<TServiceConfig, "env">>;

export interface DockerServicePresetDefaults {
	port: number;
	healthCheck: BuiltInHealthCheck;
	secondaryPort?: number;
}

export interface DockerServicePreset<
	TOptions extends PresetServiceSharedOptions = PresetServiceSharedOptions,
	TServiceConfig extends ServiceConfig = ServiceConfig,
> {
	preset: DockerPresetName;
	defaults: DockerServicePresetDefaults;
	env?: TServiceConfig["env"];
	build: DockerServiceFactory;
	createPresetDefinition(
		service?: DockerComposeServiceRaw,
	): DockerPresetServiceDefinition;
	toServiceConfig(options?: TOptions): TServiceConfig;
}

interface DefineDockerServiceInput<
	TOptions extends PresetServiceSharedOptions = PresetServiceSharedOptions,
	TServiceConfig extends ServiceConfig = ServiceConfig,
> {
	preset: DockerPresetName;
	defaults: DockerServicePresetDefaults;
	env?: TServiceConfig["env"];
	build: DockerServiceFactory;
	/** Add the fields only this preset understands (credentials, secondary port, ...). */
	enhanceServiceConfig?: (
		base: PresetServiceConfigBase<TServiceConfig>,
		options: TOptions | undefined,
	) => TServiceConfig;
}

/**
 * Define a docker service preset as single source of truth.
 * The same definition powers:
 * - compose generation (`build`)
 * - typed config helper defaults (`toServiceConfig`)
 */
export function defineDockerService<
	TOptions extends PresetServiceSharedOptions = PresetServiceSharedOptions,
	TServiceConfig extends ServiceConfig = ServiceConfig,
>(
	input: DefineDockerServiceInput<TOptions, TServiceConfig>,
): DockerServicePreset<TOptions, TServiceConfig> {
	function createPresetDefinition(
		service?: DockerComposeServiceRaw,
	): DockerPresetServiceDefinition {
		return {
			kind: "preset",
			preset: input.preset,
			service,
		};
	}

	function toServiceConfig(options?: TOptions): TServiceConfig {
		const base: PresetServiceConfigBase<TServiceConfig> = {
			port: options?.port ?? input.defaults.port,
			expose: options?.expose,
			healthCheck: options?.healthCheck ?? input.defaults.healthCheck,
			serviceName: options?.serviceName,
			env: input.env,
			docker: createPresetDefinition(options?.docker),
		};
		if (input.enhanceServiceConfig) {
			return input.enhanceServiceConfig(base, options);
		}
		// Without an enhancer the preset contributes nothing beyond the base, so
		// its config type is exactly this shape - TServiceConfig hides that.
		return base as TServiceConfig;
	}

	return {
		preset: input.preset,
		defaults: input.defaults,
		env: input.env,
		build: input.build,
		createPresetDefinition,
		toServiceConfig,
	};
}
