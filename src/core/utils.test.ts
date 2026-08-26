import { describe, expect, it } from "bun:test";
import { defineDevConfig } from "../config";
import { service } from "../docker-compose/services";
import { getEnvVar, sleep } from "./utils";

// ═══════════════════════════════════════════════════════════════════════════
// sleep Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("sleep", () => {
	it("resolves after specified time", async () => {
		const start = Date.now();

		await sleep(50);

		const elapsed = Date.now() - start;
		// Allow some tolerance for timing
		expect(elapsed).toBeGreaterThanOrEqual(45);
		expect(elapsed).toBeLessThan(150);
	});

	it("resolves immediately for 0ms", async () => {
		const start = Date.now();

		await sleep(0);

		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(50);
	});
});

describe("getEnvVar", () => {
	it("returns shared computed env values and service-derived aliases", () => {
		const config = defineDevConfig({
			projectPrefix: "typed",
			services: {
				postgres: service.postgres({ database: "typed" }),
				nats: service.custom({
					port: 4222,
					env: {
						NATS_URL: "url",
					},
					docker: {
						image: "nats:2-alpine",
					},
				}),
			},
			apps: {
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
				web: {
					port: 5173,
					devCommand: "bun run web",
					envVars: (_ports, urls) => ({
						VITE_API_URL: urls.api,
					}),
				},
			},
		});

		const webPort = getEnvVar(config, "WEB_PORT");
		expect(typeof webPort).toBe("number");
		expect(webPort).toBeGreaterThanOrEqual(5173);
		expect(getEnvVar(config, "DATABASE_URL")).toMatch(
			/^postgresql:\/\/postgres:postgres@localhost:\d+\/typed$/,
		);
		expect(getEnvVar(config, "NATS_URL")).toMatch(/^http:\/\/localhost:\d+$/);
		expect(getEnvVar(config, "API_URL")).toMatch(/^http:\/\/localhost:\d+$/);
		expect(getEnvVar(config, "WEBLOCAL_URL")).toMatch(/^http:\/\//);
	});

	it("emits named HTTPS URLs when hosts are enabled", () => {
		const previousCi = process.env.CI;
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.CI;
		delete process.env.BUNCARGO_HOSTS;
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {
					postgres: service.postgres({ database: "typed" }),
				},
				apps: {
					api: { port: 3000, devCommand: "bun run api" },
				},
				options: { hosts: true },
			});
			expect(getEnvVar(config, "API_URL")).toMatch(
				/^https:\/\/(?:[a-z0-9-]+\.)?api\.serpier\.localhost$/,
			);
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});

	it("keeps localhost URLs when BUNCARGO_HOSTS=0", () => {
		const previousCi = process.env.CI;
		const previousHosts = process.env.BUNCARGO_HOSTS;
		delete process.env.CI;
		process.env.BUNCARGO_HOSTS = "0";
		try {
			const config = defineDevConfig({
				projectPrefix: "serpier",
				services: {
					postgres: service.postgres({ database: "typed" }),
				},
				apps: {
					api: { port: 3000, devCommand: "bun run api" },
				},
				options: { hosts: true },
			});
			expect(getEnvVar(config, "API_URL")).toMatch(/^http:\/\/localhost:\d+$/);
		} finally {
			if (previousCi === undefined) delete process.env.CI;
			else process.env.CI = previousCi;
			if (previousHosts === undefined) delete process.env.BUNCARGO_HOSTS;
			else process.env.BUNCARGO_HOSTS = previousHosts;
		}
	});
});
