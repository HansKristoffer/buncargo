// While developing buncargo in this repo, import from source for accurate types.
// In a standalone copy, use: `import { defineDevConfig, service } from "buncargo";`
import { defineDevConfig, service } from "../../src";

export default defineDevConfig({
	projectPrefix: "buncargo-playground",

	services: {
		// Non-default host port so the playground can run alongside another Postgres on 5432.
		postgres: service.postgres({ database: "playground", port: 5433 }),
	},

	apps: {
		api: {
			port: 3010,
			expose: true,
			devCommand: "bun run dev",
			cwd: "apps/api",
			healthEndpoint: "/health",
			requiredServices: ["postgres"],
		},
		web: {
			port: 5199,
			devCommand: "bun run dev",
			cwd: "apps/web",
			healthEndpoint: "/",
			requiredApps: ["api"],
		},
	},

	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
		VITE_API_URL: urls.api,
	}),
});
