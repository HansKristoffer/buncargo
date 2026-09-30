import { defineDevConfig } from "../../src/config";

export default defineDevConfig({
	projectPrefix: "library-sessions",
	services: {},
	apps: {
		web: {
			port: 3100,
			devCommand: `bun -e 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("web") })'`,
		},
		api: {
			port: 3101,
			devCommand: `bun -e 'Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("api") })'`,
		},
	},
	options: { verbose: false },
});
