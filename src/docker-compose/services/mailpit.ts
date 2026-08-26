import type { ServiceConfig } from "../../types";
import {
	defineDockerService,
	type PresetServiceSecondaryPortOptions,
} from "./define-docker-service";
import { getDefaultPortBindings, resolveHealthcheck } from "./shared";

export type MailpitServiceOptions = PresetServiceSecondaryPortOptions;

export type MailpitServiceConfig = ServiceConfig<{
	MAILPIT_URL: "url";
	SMTP_PORT: "secondaryPort";
}> & {
	secondaryPort: number;
};

export const mailpitDockerService = defineDockerService<
	MailpitServiceOptions,
	MailpitServiceConfig
>({
	preset: "mailpit",
	defaults: {
		port: 8025,
		secondaryPort: 1025,
		healthCheck: "http",
	},
	env: {
		MAILPIT_URL: "url",
		SMTP_PORT: "secondaryPort",
	},
	enhanceServiceConfig: (base, options): MailpitServiceConfig => ({
		...base,
		secondaryPort: options?.secondaryPort ?? 1025,
		healthCheck: options?.healthCheck ?? false,
		staticEnv: {
			SMTP_HOST: "localhost",
		},
	}),
	build: ({ serviceKey, config }) => {
		return {
			service: {
				image: "axllent/mailpit",
				restart: "unless-stopped",
				ports: getDefaultPortBindings(serviceKey, config, "mailpit"),
				volumes: [`${serviceKey}_data:/data`],
				environment: {
					MP_MAX_MESSAGES: 5000,
					MP_DATABASE: "/data/mailpit.db",
					MP_SMTP_AUTH_ACCEPT_ANY: "1",
					MP_SMTP_AUTH_ALLOW_INSECURE: "1",
				},
				healthcheck: resolveHealthcheck(config.healthCheck, undefined, {
					internalPort: 8025,
				}),
			},
			volume: `${serviceKey}_data`,
		};
	},
});
