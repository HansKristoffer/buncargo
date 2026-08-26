import type {
	DockerComposeServiceRaw,
	DockerPresetName,
	ServiceConfig,
	ServiceEnvVarMap,
} from "../../types";
import type { DockerServicePreset } from "./define-docker-service";

export type {
	DockerServicePreset,
	DockerServicePresetDefaults,
	PresetServiceCredentialOptions,
	PresetServiceSecondaryPortOptions,
	PresetServiceSharedOptions,
} from "./define-docker-service";

import {
	type ClickhouseServiceOptions,
	clickhouseDockerService,
} from "./clickhouse";
import { type MailpitServiceOptions, mailpitDockerService } from "./mailpit";
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
} satisfies Record<DockerPresetName, DockerServicePreset>;

export {
	clickhouseDockerService,
	mailpitDockerService,
	postgresDockerService,
	redisDockerService,
	typesenseDockerService,
};
export type {
	ClickhouseServiceOptions,
	MailpitServiceOptions,
	PostgresServiceOptions,
	RedisServiceOptions,
	TypesenseServiceOptions,
};

export type CustomServiceOptions<
	TEnv extends ServiceEnvVarMap = ServiceEnvVarMap,
> = ServiceConfig<TEnv> & {
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

	custom<TEnv extends ServiceEnvVarMap>(
		options: CustomServiceOptions<TEnv>,
	): ServiceConfig<TEnv> {
		return options;
	},
};

export function buildPresetDockerService(
	preset: DockerPresetName,
	input: Parameters<DockerServicePreset["build"]>[0],
): ReturnType<DockerServicePreset["build"]> {
	return PRESET_SERVICES[preset].build(input);
}
