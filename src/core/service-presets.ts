import type {
	BuiltInServiceEnvVarMap,
	DockerPresetName,
	ServiceConfig,
	ServiceEnvValueSource,
} from "../types";

/**
 * Canonical env var surface contributed by each built-in service preset.
 *
 * This is the single runtime source of truth for "which presets exist". The
 * `satisfies` clause ties it to {@link BuiltInServiceEnvVarMap}, so adding a
 * preset to the type without adding it here is a compile error (and the compose
 * builder registry in `docker-compose/services` is pinned the same way).
 */
export const BUILT_IN_SERVICE_ENV_VARS = {
	postgres: {
		DATABASE_URL: "url",
	},
	redis: {
		REDIS_URL: "url",
	},
	clickhouse: {
		CLICKHOUSE_URL: "url",
		CLICKHOUSE_NATIVE_PORT: "secondaryPort",
	},
	mailpit: {
		MAILPIT_URL: "url",
		SMTP_PORT: "secondaryPort",
	},
	typesense: {
		TYPESENSE_URL: "url",
	},
} as const satisfies BuiltInServiceEnvVarMap;

export const DOCKER_PRESET_NAMES = Object.keys(
	BUILT_IN_SERVICE_ENV_VARS,
) as readonly DockerPresetName[];

export function isDockerPresetName(value: unknown): value is DockerPresetName {
	return (
		typeof value === "string" && Object.hasOwn(BUILT_IN_SERVICE_ENV_VARS, value)
	);
}

/**
 * Resolve the built-in preset backing a service, either from an explicit
 * `service.<preset>()` helper definition or by the service key's name.
 */
export function inferDockerPreset(
	serviceKey: string,
	service?: ServiceConfig,
): DockerPresetName | undefined {
	const dockerConfig = service?.docker;
	if (dockerConfig?.kind === "preset") {
		return isDockerPresetName(dockerConfig.preset)
			? dockerConfig.preset
			: undefined;
	}

	const normalized = serviceKey.toLowerCase();
	return isDockerPresetName(normalized) ? normalized : undefined;
}

/**
 * Env vars a service contributes to the shared env surface: the preset defaults
 * plus any explicit `env` mappings declared on the service.
 */
export function resolveServiceEnvVarSources(
	serviceKey: string,
	service: ServiceConfig,
): Record<string, ServiceEnvValueSource> {
	const preset = inferDockerPreset(serviceKey, service);
	return {
		...(preset ? BUILT_IN_SERVICE_ENV_VARS[preset] : {}),
		...(service.env ?? {}),
	};
}
