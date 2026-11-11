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
