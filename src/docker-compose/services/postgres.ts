import type { DockerComposeHealthcheckRaw, ServiceConfig } from "../../types";
import {
	defineDockerService,
	type PresetServiceCredentialOptions,
} from "./define-docker-service";
import {
	composeLiteral,
	getDefaultPortBindings,
	resolveHealthcheck,
} from "./shared";

export type PostgresServiceOptions = PresetServiceCredentialOptions &
	Pick<ServiceConfig, "urlParams">;

export type PostgresServiceConfig = ServiceConfig<{
	DATABASE_URL: "url";
}> & { port: number };

/**
 * Postgres 18+ images changed upstream `VOLUME` from `/var/lib/postgresql/data`
 * to `/var/lib/postgresql` and expect `PGDATA` inside a subdirectory when a
 * volume is mounted at `/var/lib/postgresql/data`. Existing pg16/pg17 volumes
 * keep their layout untouched so nothing hides an existing database.
 */
function needsPostgres18Pgdata(image: string | undefined): boolean {
	if (!image) return false;
	const [withoutDigest] = image.split("@");
	const slash = withoutDigest.lastIndexOf("/");
	const colon = withoutDigest.indexOf(":", slash + 1);
	if (colon === -1) return false;
	const tag = withoutDigest.slice(colon + 1);
	const match = /^(?:pg)?(\d+)(?:$|[.-])/.exec(tag);
	return match !== null && Number.parseInt(match[1], 10) >= 18;
}

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
	credentials: { user: "postgres", password: "postgres", database: "postgres" },
	url: ({ host, port, credentials, urlParams }) => {
		const base = `postgresql://${credentials?.user}:${credentials?.password}@${host}:${port}/${credentials?.database}`;
		const entries = urlParams ? Object.entries(urlParams) : [];
		if (entries.length === 0) return base;
		return `${base}?${new URLSearchParams(entries).toString()}`;
	},
	enhanceServiceConfig: (base, options): PostgresServiceConfig => ({
		...base,
		database: options?.database,
		user: options?.user,
		password: options?.password,
		urlParams: options?.urlParams,
	}),
	build: ({ serviceKey, config, runtime }) => {
		const user = composeLiteral(config.credentials?.user ?? "postgres");
		const password = composeLiteral(config.credentials?.password ?? "postgres");
		const database = composeLiteral(config.credentials?.database ?? "postgres");
		const defaultHealthcheck: DockerComposeHealthcheckRaw = {
			test: ["CMD-SHELL", `pg_isready -h 127.0.0.1 -U ${user}`],
			interval: "250ms",
			timeout: "5s",
			retries: 20,
		};

		const overrideImage =
			config.docker.kind === "preset"
				? config.docker.override?.image
				: undefined;
		const needsSubdirPgdata =
			runtime === "apple" || needsPostgres18Pgdata(overrideImage);

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
					// refuses a non-empty data directory; Postgres 18+ images
					// also require PGDATA in a subdirectory. Docker on pg16/17
					// keeps the root directory so existing databases stay intact.
					...(needsSubdirPgdata
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
