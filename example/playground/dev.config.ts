// While developing buncargo in this repo, import from source for accurate types.
// In a standalone copy, use: `import { defineDevConfig, service } from "buncargo";`
import { fileURLToPath } from "node:url";
import { defineDevConfig, getWorktreeProjectSuffix, service } from "../../src";

// This config sits below the repository's top level, where buncargo does not
// see the worktree, so every worktree's playground would share one project
// (and database) with the main clone's. Each worktree gets its own prefix; the
// main clone keeps the plain one.
const worktree = getWorktreeProjectSuffix(
	fileURLToPath(new URL("../..", import.meta.url)),
);

export default defineDevConfig({
	projectPrefix: worktree
		? `buncargo-playground-${worktree}`
		: "buncargo-playground",

	docker: {
		runtime: "auto",
	},

	services: {
		// Non-default host port so the playground can run alongside another Postgres on 5432.
		postgres: service.postgres({ database: "playground", port: 5433 }),
	},

	options: {
		hosts: true,
		primaryApp: "web",
	},

	// Each app answers on its own hostname, so calls from web to api are
	// cross-origin and the api has to know which origin to allow.
	env: (_ports, urls) => ({
		WEB_URL: urls.web,
	}),

	apps: {
		api: {
			port: 3010,
			expose: true,
			devCommand: "bun run dev",
			cwd: "apps/api",
			healthEndpoint: "/health",
			requiredServices: ["postgres"],
			envVars: (_ports, urls, { publicUrls }) => ({
				WEBHOOK_URL: publicUrls.api ?? urls.api,
			}),
		},
		web: {
			port: 5199,
			devCommand: "bun run dev",
			cwd: "apps/web",
			healthEndpoint: "/",
			requiredApps: ["api"],
			envVars: (_ports, urls) => ({
				VITE_API_URL: urls.api,
			}),
		},
	},
});
