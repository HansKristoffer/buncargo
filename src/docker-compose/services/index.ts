import type {
	DockerComposeServiceRaw,
	DockerPresetName,
	EnvValues,
	ServiceConfig,
	ServiceConfigBase,
	ServiceEnvVarMap,
} from "../../types";
import type { DockerServicePreset } from "./define-docker-service";

export type {
	PresetServiceCredentialOptions,
	PresetServiceSecondaryPortOptions,
	PresetServiceSharedOptions,
} from "./define-docker-service";

import {
	type ClickhouseServiceOptions,
	clickhouseDockerService,
} from "./clickhouse";
import { type MailpitServiceOptions, mailpitDockerService } from "./mailpit";
import { minioDockerService } from "./minio";
import { type PostgresServiceOptions, postgresDockerService } from "./postgres";
import { type RedisServiceOptions, redisDockerService } from "./redis";
import {
	type TypesenseServiceOptions,
	typesenseDockerService,
} from "./typesense";

const PRESET_SERVICES = {
	postgres: postgresDockerService,
	redis: redisDockerService,
	clickhouse: clickhouseDockerService,
	mailpit: mailpitDockerService,
	typesense: typesenseDockerService,
	minio: minioDockerService,
} satisfies Record<DockerPresetName, DockerServicePreset>;

export type {
	ClickhouseServiceOptions,
	MailpitServiceOptions,
	PostgresServiceOptions,
	RedisServiceOptions,
	TypesenseServiceOptions,
};

export type CustomServiceOptions<
	TEnv extends ServiceEnvVarMap = ServiceEnvVarMap,
	TStatic extends EnvValues = EnvValues,
> = ServiceConfig<TEnv, TStatic> & {
	docker: DockerComposeServiceRaw;
};

/**
 * A container run to completion on every start: everything a service takes
 * except what a job cannot have (a port, a URL, a health check).
 */
export type JobServiceOptions<
	TEnv extends ServiceEnvVarMap = ServiceEnvVarMap,
	TStatic extends EnvValues = EnvValues,
> = Omit<
	ServiceConfigBase<TEnv, TStatic>,
	| "port"
	| "secondaryPort"
	| "healthCheck"
	| "expose"
	| "exposeProtocol"
	| "urlTemplate"
	| "docker"
> & {
	docker: DockerComposeServiceRaw;
};

/**
 * Public service builders for dev.config.ts.
 * Core owns this surface so defaults and preset mapping live in one place.
 */
export const service = {
	postgres: postgresDockerService.toServiceConfig,
	redis: redisDockerService.toServiceConfig,
	clickhouse: clickhouseDockerService.toServiceConfig,
	mailpit: mailpitDockerService.toServiceConfig,
	typesense: typesenseDockerService.toServiceConfig,
	minio: minioDockerService.toServiceConfig,

	custom<
		const TEnv extends ServiceEnvVarMap,
		const TStatic extends EnvValues = EnvValues,
	>(
		options: CustomServiceOptions<TEnv, TStatic>,
	): ServiceConfig<TEnv, TStatic> {
		return options;
	},

	/**
	 * A job: `kind: "job"` and `rerun: "always"` without the `as const` a
	 * hand-written one needs. Another service waits for it with
	 * `depends_on: { <key>: { condition: "service_completed_successfully" } }`.
	 */
	job<
		const TEnv extends ServiceEnvVarMap,
		const TStatic extends EnvValues = EnvValues,
	>(
		options: JobServiceOptions<TEnv, TStatic>,
	): ServiceConfig<TEnv, TStatic> & { kind: "job"; rerun: "always" } {
		return { ...options, kind: "job", rerun: "always" };
	},
};

export function buildPresetDockerService(
	preset: DockerPresetName,
	input: Parameters<DockerServicePreset["build"]>[0],
): ReturnType<DockerServicePreset["build"]> {
	return PRESET_SERVICES[preset].build(input);
}
