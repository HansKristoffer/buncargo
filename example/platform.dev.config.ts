// In this repository we import local source for accurate in-progress types.
// In external projects, use: import { defineDevConfig, service } from "buncargo";
import { defineDevConfig, service } from "../src";

export default defineDevConfig({
	projectPrefix: "gey",

	services: {
		postgres: service.postgres({ database: "geysier" }),
		redis: service.redis(),
		clickhouse: service.clickhouse({ database: "geysier" }),
	},

	apps: {
		api: {
			port: 3000,
			expose: true,
			devCommand: "bun run dev",
			cwd: "apps/backend",
			healthEndpoint: "/api/webhooks/health",
			requiredServices: ["postgres", "redis", "clickhouse"],
		},
		platform: {
			port: 5173,
			devCommand: "bun run dev",
			cwd: "apps/platform",
			healthEndpoint: "/",
			requiredApps: ["api"],
		},
	},

	envVars: (ports, urls, { localIp }) => ({
		DATABASE_URL: urls.postgres,
		BASE_URL: urls.api,
		VITE_API_URL: urls.api,
		VITE_PORT: ports.platform,
		CLICKHOUSE_NATIVE_PORT: ports.clickhouseSecondary,
		EXPO_PUBLIC_API_URL: `http://${localIp}:${ports.api}`,
		SECRETS_ENV: "dev",
	}),

	migrations: [
		{
			name: "clickhouse",
			command: "bun apps/backend/src/lib/clickhouse/run-ch-migrate.ts",
		},
	],

	seed: {
		command: "bun run run:seeder",
		check: ({ checkTable }) => checkTable("User", "postgres"),
	},

	prisma: {
		cwd: "packages/prisma",
	},
});
