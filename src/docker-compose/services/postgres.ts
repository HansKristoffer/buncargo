import type { DockerComposeHealthcheckRaw, ServiceConfig } from "../../types";
import {
	defineDockerService,
	type PresetServiceCredentialOptions,
} from "./define-docker-service";
import { getDefaultPortBindings, resolveHealthcheck } from "./shared";

export type PostgresServiceOptions = PresetServiceCredentialOptions;

export type PostgresServiceConfig = ServiceConfig<{
	DATABASE_URL: "url";
}>;

export const postgresDockerService = defineDockerService<
	PostgresServiceOptions,
	PostgresServiceConfig
>({
	preset: "postgres",
	defaults: {
		port: 5432,
		healthCheck: "pg_isready",
	},
	env: {
		DATABASE_URL: "url",
	},
	enhanceServiceConfig: (base, options): PostgresServiceConfig => ({
		...base,
		database: options?.database,
		user: options?.user,
		password: options?.password,
	}),
	build: ({ serviceKey, config, runtime }) => {
		const user = config.user ?? "postgres";
		const password = config.password ?? "postgres";
		const database = config.database ?? "postgres";
		const defaultHealthcheck: DockerComposeHealthcheckRaw = {
			test: ["CMD-SHELL", `pg_isready -U ${user}`],
			interval: "250ms",
			timeout: "5s",
			retries: 20,
		};

		return {
			service: {
				image: "pgvector/pgvector:pg16",
				ports: getDefaultPortBindings(serviceKey, config, "postgres"),
				volumes: [`${serviceKey}_data:/var/lib/postgresql/data`],
				environment: {
					POSTGRES_USER: user,
					POSTGRES_PASSWORD: password,
					POSTGRES_DB: database,
					// Apple's named volumes are formatted block devices, so the
					// mount root already holds a `lost+found` and `initdb`
					// refuses a non-empty data directory. Docker's are plain
					// directories, and moving them to a subdirectory would hide
					// every existing project's database behind an empty one.
					...(runtime === "apple"
						? { PGDATA: "/var/lib/postgresql/data/pgdata" }
						: {}),
				},
				healthcheck: resolveHealthcheck(
					config.healthCheck,
					defaultHealthcheck,
					{
						internalPort: 5432,
						user,
					},
				),
			},
			volume: `${serviceKey}_data`,
		};
	},
});
