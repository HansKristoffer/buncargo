import { describe, expect, it } from "bun:test";
import { service } from "../../docker-compose/services";
import { validateConfig } from "..";

describe("service and app keys", () => {
	it("rejects two keys that spell one env name, naming both", () => {
		const errors = validateConfig({
			projectPrefix: "myapp",
			services: {
				"my-db": service.postgres({ port: 5432 }),
				my_db: service.postgres({ port: 5433 }),
			},
			apps: { "web-admin": { port: 3000, devCommand: "bun run dev" } },
		});

		expect(errors).toContain(
			"services.my-db and services.my_db share the env name MY_DB (MY_DB_PORT, MY_DB_URL): rename one of them",
		);
		expect(errors.filter((error) => error.includes("web-admin"))).toEqual([]);
	});

	it("names a service and an app whose keys differ only by a hyphen", () => {
		const errors = validateConfig({
			projectPrefix: "myapp",
			services: { web_admin: { port: 5432, docker: { image: "nginx:1" } } },
			apps: { "web-admin": { port: 3000, devCommand: "bun run dev" } },
		});

		expect(errors).toContain(
			"services.web_admin and apps.web-admin share the env name WEB_ADMIN (WEB_ADMIN_PORT, WEB_ADMIN_URL): rename one of them",
		);
	});
});

describe("nested sections", () => {
	it("names unknown keys and wrong types in captures, watch, secrets, tasks and profiles", () => {
		const errors = validateConfig({
			projectPrefix: "myapp",
			services: {},
			secrets: { projectId: "p", only: "API_KEY" },
			apps: {
				web: {
					port: 3000,
					devCommand: "bun run dev",
					captures: {
						token: {
							pattern: /t: (\S+)/,
							as: "value",
							secret: "yes",
							envv: "X",
						},
					},
					watch: { paths: ["src"], debounce: 100 },
					secrets: { exclude: [""] },
				},
			},
			tasks: { gen: { command: "bun gen", requiredService: ["db"] } },
			profiles: { full: { apps: ["web"], app: "web" } },
		});

		expect(errors).toEqual(
			expect.arrayContaining([
				"secrets.only must be an array of secret names",
				"apps.web.captures.token.envv is not an option (pattern, as, label, env, secret)",
				"apps.web.captures.token.secret must be a boolean",
				"apps.web.watch.debounce is not an option (paths, ignore, debounceMs)",
				"apps.web.secrets.exclude must be an array of secret names",
				"tasks.gen.requiredService is not an option (command, description, app, cwd, requiredServices)",
				"profiles.full.app is not an option (apps, description)",
			]),
		);
	});
});
