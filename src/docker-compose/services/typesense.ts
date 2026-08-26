import type { DockerComposeHealthcheckRaw, ServiceConfig } from "../../types";
import {
	defineDockerService,
	type PresetServiceSharedOptions,
} from "./define-docker-service";
import { getDefaultPortBindings, resolveHealthcheck } from "./shared";

export type TypesenseServiceOptions = PresetServiceSharedOptions & {
	/** Bootstrap API key (default: `xyz`) */
	apiKey?: string;
};

export type TypesenseServiceConfig = ServiceConfig<
	{ TYPESENSE_URL: "url" },
	{ TYPESENSE_API_KEY: string }
>;

export const typesenseDockerService = defineDockerService<
	TypesenseServiceOptions,
	TypesenseServiceConfig
>({
	preset: "typesense",
	defaults: {
		port: 8108,
		healthCheck: "http",
	},
	env: {
		TYPESENSE_URL: "url",
	},
	enhanceServiceConfig: (base, options): TypesenseServiceConfig => ({
		...base,
		staticEnv: {
			TYPESENSE_API_KEY: options?.apiKey ?? "xyz",
		},
	}),
	build: ({ serviceKey, config }) => {
		const apiKey = config.staticEnv?.TYPESENSE_API_KEY ?? "xyz";
		const defaultHealthcheck: DockerComposeHealthcheckRaw = {
			test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:8108/health || exit 1"],
			interval: "250ms",
			timeout: "5s",
			retries: 20,
		};

		return {
			service: {
				image: "typesense/typesense:29.0",
				restart: "on-failure",
				ports: getDefaultPortBindings(serviceKey, config, "typesense"),
				volumes: [`${serviceKey}_data:/data`],
				environment: {
					TYPESENSE_API_KEY: apiKey,
				},
				command: `--data-dir /data --api-key=\${TYPESENSE_API_KEY:-${apiKey}} --enable-cors`,
				healthcheck: resolveHealthcheck(
					config.healthCheck,
					defaultHealthcheck,
					{
						internalPort: 8108,
					},
				),
			},
			volume: `${serviceKey}_data`,
		};
	},
});
