import type { DockerComposeHealthcheckRaw, ServiceConfig } from "../../types";
import {
	defineDockerService,
	type PresetServiceSharedOptions,
} from "./define-docker-service";
import { getDefaultPortBindings, resolveHealthcheck } from "./shared";

/** `redis://host:port` carries no credentials, so the preset takes none. */
export type RedisServiceOptions = PresetServiceSharedOptions;

export type RedisServiceConfig = ServiceConfig<{
	REDIS_URL: "url";
}>;

export const redisDockerService = defineDockerService<
	RedisServiceOptions,
	RedisServiceConfig
>({
	preset: "redis",
	defaults: {
		port: 6379,
		healthCheck: "redis-cli",
	},
	env: {
		REDIS_URL: "url",
	},
	build: ({ serviceKey, config }) => {
		const defaultHealthcheck: DockerComposeHealthcheckRaw = {
			test: ["CMD", "redis-cli", "ping"],
			interval: "250ms",
			timeout: "5s",
			retries: 20,
		};

		return {
			service: {
				image: "redis:7-alpine",
				ports: getDefaultPortBindings(serviceKey, config, "redis"),
				healthcheck: resolveHealthcheck(
					config.healthCheck,
					defaultHealthcheck,
					{
						internalPort: 6379,
					},
				),
			},
		};
	},
});
