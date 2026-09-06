import { describe, expect, it } from "bun:test";
import { assertValidConfig, validateConfig } from "./validate-config";

const config = () => ({
	projectPrefix: "test",
	services: { postgres: { port: 5432 } },
	apps: { web: { port: 3000, devCommand: "bun run dev" } },
});

describe("unknown config boundary", () => {
	it.each([null, undefined, [], 4, "config"].map((input) => [input]))(
		"rejects outer shape %j",
		(input) => {
			expect(() => assertValidConfig(input)).toThrow("Invalid dev config:");
		},
	);
	it("aggregates nested shape errors with field paths", () => {
		const errors = validateConfig({
			...config(),
			services: { postgres: null },
			apps: { web: { port: 3000, requiredApps: 1 } },
			seed: false,
			migrations: [null],
		});
		expect(errors).toContain("services.postgres must be an object");
		expect(errors).toContain(
			"apps.web.requiredApps must be an array of nonempty strings",
		);
		expect(errors).toContain("seed must be an object");
		expect(errors).toContain("migrations.0 must be an object");
	});
	it.each([NaN, Infinity, -1, 0, 1.5, 65536, "3000"])(
		"rejects invalid app port %j",
		(port) => {
			expect(
				validateConfig({
					...config(),
					apps: { web: { port, devCommand: false } },
				}).join("\n"),
			).toContain("apps.web.port");
		},
	);
	it("rejects secondary port collisions and derived namespace collisions", () => {
		const errors = validateConfig({
			...config(),
			services: { postgres: { port: 5432, secondaryPort: 3000 } },
			apps: { postgresSecondary: { port: 3000, devCommand: false } },
		});
		expect(errors.join("\n")).toContain(
			"conflicts with services.postgres.secondaryPort",
		);
		expect(errors.join("\n")).toContain("duplicates port 3000");
	});
	it("rejects app/service name collisions even with different ports", () => {
		expect(
			validateConfig({
				...config(),
				apps: { postgres: { port: 3000, devCommand: false } },
			}).join("\n"),
		).toContain("computed ports/URLs namespace");
	});
	it.each([NaN, Infinity, -1, 0, "100"])(
		"rejects invalid health duration %j",
		(healthTimeout) => {
			expect(
				validateConfig({
					...config(),
					apps: { web: { port: 3000, devCommand: false, healthTimeout } },
				}).join("\n"),
			).toContain("apps.web.healthTimeout");
		},
	);
	it("validates primary-app references even with no apps", () => {
		expect(
			validateConfig({
				...config(),
				apps: undefined,
				options: { primaryApp: "web", hosts: { primaryApp: "web" } },
			}).join("\n"),
		).toContain('options.primaryApp "web"');
	});
	it("preserves raw Compose extensions", () => {
		expect(
			validateConfig({
				...config(),
				services: {
					postgres: {
						port: 5432,
						docker: { image: "postgres", "x-vendor": { arbitrary: true } },
					},
				},
			}),
		).toEqual([]);
	});
});
