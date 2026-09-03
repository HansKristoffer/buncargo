import { describe, expect, it } from "bun:test";
import type { ServiceConfig } from "../types";
import { describeService, tablePlusUrl } from "./service-identity";

describe("describeService", () => {
	it("recognises a preset service under any key", () => {
		const identity = describeService({
			name: "db",
			service: {
				port: 5432,
				docker: { kind: "preset", preset: "postgres" },
				database: "lullu",
			} as unknown as ServiceConfig,
			port: 7432,
			projectName: "lullu-main",
		});
		expect(identity.preset).toBe("postgres");
		expect(identity.database).toBe(true);
		expect(identity.tablePlusUrl).toContain("postgresql://");
		expect(identity.tablePlusUrl).toContain("7432");
		expect(identity.tablePlusUrl).toContain("lullu");
	});

	it("falls back to the key when there is no explicit preset", () => {
		const identity = describeService({
			name: "postgres",
			service: { port: 5432 } as ServiceConfig,
			port: 7432,
		});
		expect(identity.preset).toBe("postgres");
		expect(identity.tablePlusUrl).toBeDefined();
	});

	it("offers no database link for a custom service", () => {
		const identity = describeService({
			name: "rabbitmq",
			service: { port: 5672 } as ServiceConfig,
			port: 7672,
		});
		expect(identity.preset).toBeUndefined();
		expect(identity.database).toBe(false);
		expect(identity.tablePlusUrl).toBeUndefined();
	});

	it("uses the configured credentials", () => {
		const identity = describeService({
			name: "postgres",
			service: {
				port: 5432,
				user: "app",
				password: "s3cret",
				database: "shop",
			} as unknown as ServiceConfig,
			port: 7432,
		});
		expect(identity.tablePlusUrl).toContain("app:s3cret@");
		expect(identity.tablePlusUrl).toContain("/shop");
	});

	it("marks an HTTP service openable", () => {
		expect(
			describeService({
				name: "mailpit",
				service: { port: 8025 } as ServiceConfig,
				port: 8025,
			}).http,
		).toBe(true);
	});

	it("survives a port that was never allocated", () => {
		const identity = describeService({
			name: "postgres",
			service: { port: 5432 } as ServiceConfig,
			port: undefined,
		});
		expect(identity.tablePlusUrl).toBeUndefined();
	});
});

describe("tablePlusUrl", () => {
	it("keeps the name and env query parameters TablePlus expects", () => {
		const url = tablePlusUrl({
			user: "postgres",
			password: "postgres",
			port: 7432,
			database: "app",
			name: "proj-postgres",
		});
		expect(url).toContain("env=development");
		expect(url).toContain("name=proj-postgres");
		expect(url).toContain("tLSMode=0");
	});
});
