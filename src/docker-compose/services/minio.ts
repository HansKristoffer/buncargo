import type { ServiceConfig } from "../../types";
import {
	defineDockerService,
	type PresetServiceSharedOptions,
} from "./define-docker-service";
import { composeLiteral, getDefaultPortBindings } from "./shared";

export type MinioServiceOptions = PresetServiceSharedOptions & {
	/** Root user, the S3 access key (default: `minioadmin`) */
	user?: string;
	/** Root password, the S3 secret key; MinIO wants 8 characters or more (default: `minioadmin`) */
	password?: string;
};

export type MinioServiceConfig = ServiceConfig<
	{ MINIO_URL: "url" },
	{ MINIO_ROOT_USER: string; MINIO_ROOT_PASSWORD: string }
> & { port: number };

const DEFAULT_CREDENTIAL = "minioadmin";

/**
 * `minio/minio` is no longer published on Docker Hub. Chainguard builds the
 * same server, and its free tier tags only `latest`, which a warm start cannot
 * prove unchanged: the digest is `latest` on 2026-10-27.
 */
const MINIO_IMAGE =
	"cgr.dev/chainguard/minio@sha256:e70b2b1e74d79457f808710483bd726ff364529ca30736eaa15a6ab547d3a5a7";

/**
 * The image has no curl or wget, so bash opens the port. Jobs that wait on
 * `service_healthy` (`mc mb`) need it, even though buncargo's own readiness
 * polls the published port.
 */
const MINIO_HEALTHCHECK = {
	test: ["CMD", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/9000"],
	interval: "1s",
	timeout: "5s",
	retries: 30,
};

export const minioDockerService = defineDockerService<
	MinioServiceOptions,
	MinioServiceConfig
>({
	preset: "minio",
	defaults: {
		port: 9000,
		// `GET /` answers 403 to an anonymous client, so the `http` probe never
		// passes; buncargo polls the published port instead.
		healthCheck: "tcp",
	},
	env: {
		MINIO_URL: "url",
	},
	url: ({ host, port }) => `http://${host}:${port}`,
	enhanceServiceConfig: (base, options): MinioServiceConfig => ({
		...base,
		staticEnv: {
			MINIO_ROOT_USER: options?.user ?? DEFAULT_CREDENTIAL,
			MINIO_ROOT_PASSWORD: options?.password ?? DEFAULT_CREDENTIAL,
		},
	}),
	build: ({ serviceKey, config }) => {
		const user = composeLiteral(
			String(config.staticEnv?.MINIO_ROOT_USER ?? DEFAULT_CREDENTIAL),
		);
		const password = composeLiteral(
			String(config.staticEnv?.MINIO_ROOT_PASSWORD ?? DEFAULT_CREDENTIAL),
		);
		const healthcheck =
			config.healthCheck === false ? undefined : MINIO_HEALTHCHECK;

		return {
			service: {
				image: MINIO_IMAGE,
				command: ["server", "/data"],
				ports: getDefaultPortBindings(serviceKey, config, "minio"),
				volumes: [`${serviceKey}_data:/data`],
				environment: {
					MINIO_ROOT_USER: user,
					MINIO_ROOT_PASSWORD: password,
				},
				healthcheck,
			},
			volume: `${serviceKey}_data`,
		};
	},
});
