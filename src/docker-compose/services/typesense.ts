import type { ServiceConfig } from "../../types";
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
		// The image ships neither wget nor curl, so any in-container HTTP probe
		// is permanently unhealthy. "tcp" emits no compose healthcheck and lets
		// buncargo's host-side port poll gate readiness instead.
		healthCheck: "tcp",
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
				healthcheck: resolveHealthcheck(config.healthCheck, undefined, {
					internalPort: 8108,
				}),
			},
			volume: `${serviceKey}_data`,
		};
	},
});
