import { isOneOf, typedKeys } from "hanzio";
import type { BuiltInServiceEnvVarMap, DockerPresetName } from "../types";

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
	minio: {
		MINIO_URL: "url",
	},
} as const satisfies BuiltInServiceEnvVarMap;

export const DOCKER_PRESET_NAMES: readonly DockerPresetName[] = typedKeys(
	BUILT_IN_SERVICE_ENV_VARS,
);

export function isDockerPresetName(value: unknown): value is DockerPresetName {
	return (
		typeof value === "string" && Object.hasOwn(BUILT_IN_SERVICE_ENV_VARS, value)
	);
}

/** Primary host-port transport. Custom services use raw TCP unless explicitly overridden. */
export function defaultServiceProtocol(
	preset: string | undefined,
): "http" | "tcp" {
	return isOneOf(["clickhouse", "mailpit", "typesense", "minio"], preset)
		? "http"
		: "tcp";
}
