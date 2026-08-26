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
			staticEnv: { SECRETS_ENV: "dev" },
			envVars: (ports, urls, { localIp }) => ({
				BASE_URL: urls.api,
				EXPO_PUBLIC_API_URL: `http://${localIp}:${ports.api}`,
			}),
		},
		platform: {
			port: 5173,
			devCommand: "bun run dev",
			cwd: "apps/platform",
			healthEndpoint: "/",
			requiredApps: ["api"],
			envVars: (_ports, urls) => ({
				VITE_API_URL: urls.api,
			}),
		},
		expoApp: {
			port: 8081,
			cwd: "apps/expo",
			devCommand: "bunx expo start",
			interactive: true,
			needsPublicUrls: true,
			healthEndpoint: false,
			expose: true,
			requiredApps: ["api"],
			envVars: (_ports, _urls, { publicUrls }) => ({
				...(publicUrls.expoApp
					? { EXPO_PACKAGER_PROXY_URL: publicUrls.expoApp }
					: {}),
			}),
		},
	},

	migrations: [
		{
			name: "clickhouse",
			command: "bun apps/backend/src/lib/clickhouse/run-ch-migrate.ts",
		},
	],

	seed: {
		command: "bun run run:seeder",
		check: ({ checkTable }) => checkTable("User"),
	},

	prisma: {
		cwd: "packages/prisma",
	},
});
