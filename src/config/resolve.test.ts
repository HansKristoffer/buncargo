import { afterEach, describe, expect, it } from "bun:test";
import { withoutCiEnv } from "../core/test-env.testing";
import { service } from "../docker-compose/services";
import { resolveApp, resolveService } from "./resolve";
import { validateConfig } from "./validate-config";

const context = { port: 6000, host: "localhost", localIp: "10.0.0.2" };

describe("resolveService", () => {
	it("resolves a bare preset key like the preset's helper", () => {
		const bare = resolveService("postgres", { port: 5432 });
		const helper = resolveService("db", service.postgres());
		if (bare.kind !== "container" || helper.kind !== "container")
			throw new Error("both are containers with a port");

		const { url: bareUrl, serviceName: _bare, ...bareShape } = bare;
		const { url: helperUrl, serviceName: _helper, ...helperShape } = helper;
		expect(bareShape).toEqual(helperShape);
		expect(bare).toMatchObject({
			kind: "container",
			preset: "postgres",
			healthCheck: "pg_isready",
			env: { DATABASE_URL: "url" },
		});
		expect(bareUrl(context)).toBe(
			"postgresql://postgres:postgres@localhost:6000/postgres",
		);
		expect(helperUrl(context)).toBe(bareUrl(context));
	});

	it("takes a raw definition under a preset's key as a custom container", () => {
		const raw = resolveService("postgres", {
			port: 5432,
			docker: { image: "postgis/postgis:16" },
		});

		expect(raw.preset).toBeUndefined();
		expect(raw.env).toEqual({});
		expect(raw.port === undefined ? undefined : raw.url(context)).toBe(
			"http://localhost:6000",
		);
	});

	it("keeps a bare preset key without a port portless", () => {
		const portless = resolveService("redis", {});

		expect(portless.kind).toBe("portless");
		expect(portless.env).toEqual({});
	});
});

describe("resolveApp", () => {
	const ci = process.env.CI;
	afterEach(() => {
		if (ci === undefined) delete process.env.CI;
		else process.env.CI = ci;
	});

	it("reads an app's kind and readiness from what it declares", () => {
		expect(resolveApp({ port: 3000, devCommand: "dev" })).toMatchObject({
			kind: "server",
			readiness: { kind: "http", path: "/", declared: false },
			essential: true,
		});
		expect(
			resolveApp({ port: 3000, devCommand: "dev", healthEndpoint: "/health" })
				.readiness,
		).toEqual({ kind: "http", path: "/health", declared: true });
		expect(
			resolveApp({ port: 3000, devCommand: "dev", readyWhen: /up/ }).readiness,
		).toEqual({ kind: "output", pattern: /up/ });
		expect(resolveApp({ kind: "worker", devCommand: "run" })).toMatchObject({
			kind: "worker",
			readiness: { kind: "alive" },
		});
		expect(resolveApp({ port: 3000, devCommand: false }).kind).toBe("portOnly");
	});

	it("gives an app a minute to become ready, two in CI", () => {
		withoutCiEnv(() => {
			expect(resolveApp({ port: 3000, devCommand: "dev" }).healthTimeout).toBe(
				60_000,
			);
			process.env.CI = "true";
			expect(resolveApp({ port: 3000, devCommand: "dev" }).healthTimeout).toBe(
				120_000,
			);
			expect(
				resolveApp({ port: 3000, devCommand: "dev", healthTimeout: 5000 })
					.healthTimeout,
			).toBe(5000);
		});
	});
});

describe("unknown keys", () => {
	it("rejects a misspelt app option instead of probing `/`", () => {
		expect(
			validateConfig({
				projectPrefix: "typo",
				services: {},
				apps: {
					api: { port: 3000, devCommand: "dev", healthEndpont: "/health" },
				},
			}),
		).toContainEqual(
			expect.stringContaining("apps.api.healthEndpont is not an option"),
		);
	});

	it("names the replacement for a renamed field", () => {
		expect(
			validateConfig({
				projectPrefix: "renamed",
				services: {},
				checks: [],
			}),
		).toEqual(["checks was renamed: use setupChecks"]);
	});

	it("rejects credentials on a custom container, which nothing reads", () => {
		expect(
			validateConfig({
				projectPrefix: "creds",
				services: {
					db: { port: 5432, database: "app", docker: { image: "mysql:8" } },
				},
			}),
		).toContainEqual(expect.stringContaining('Service "db" sets database'));
	});
});
