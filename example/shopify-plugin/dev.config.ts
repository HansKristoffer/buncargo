// In this repository we import local source for accurate in-progress types.
// In a project: import { defineDevConfig } from "buncargo" and
// import { shopify } from "buncargo/shopify".
import { defineDevConfig } from "../../src";
import { shopify } from "../../src/shopify";

/**
 * A single-shop Shopify app, the way buncargo runs one: buncargo owns the API,
 * the admin UI and the extension watchers; `shopify app dev` owns the tunnel.
 * A real project adds `services: { postgres: service.postgres() }` and
 * `requiredServices`; this example stays app-only so CI boots it without Docker.
 */
export default defineDevConfig({
	projectPrefix: "shopex",
	services: {},
	apps: {
		api: {
			port: 3100,
			cwd: "apps/backend",
			devCommand: "bun run dev",
			healthEndpoint: "/health",
		},
		platform: {
			port: 5190,
			cwd: "apps/platform",
			devCommand: "bun run dev",
			requiredApps: ["api"],
		},
	},
	integrations: [
		shopify({
			config: "shopify.app.toml",
			frontend: "platform",
			backend: "api",
		}),
	],
	generatedFiles: [
		{
			path: "extensions/theme-prints/src/application-url.generated.ts",
			render: ({ captured, env }) =>
				`export const APPLICATION_URL = ${JSON.stringify(captured.appUrl ?? env.BASE_URL ?? "")};\n`,
			gitignore: true,
		},
	],
	profiles: {
		default: { apps: ["shopify"] },
		api: { apps: ["api"] },
	},
});
