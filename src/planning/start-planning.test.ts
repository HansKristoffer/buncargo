import { describe, expect, it } from "bun:test";
import type { AppConfig, ServiceConfig } from "../types";
import {
	buildServicePlan,
	buildStartPlan,
	getComposeServiceName,
	resolveSelectedApps,
} from "./start-planning";

describe("resolveSelectedApps", () => {
	it("expands selected apps through transitive requiredApps", () => {
		const apps: Record<string, AppConfig> = {
			api: {
				port: 3000,
				devCommand: "bun run api",
			},
			expo: {
				port: 8081,
				devCommand: "bun run expo",
				requiredApps: ["api"],
			},
		};

		const plan = resolveSelectedApps(apps, ["expo"]);

		expect(plan.appNames).toEqual(["api", "expo"]);
		expect(Object.keys(plan.apps)).toEqual(["api", "expo"]);
	});

	it("throws for circular requiredApps", () => {
		const apps: Record<string, AppConfig> = {
			api: {
				port: 3000,
				devCommand: "bun run api",
				requiredApps: ["expo"],
			},
			expo: {
				port: 8081,
				devCommand: "bun run expo",
				requiredApps: ["api"],
			},
		};

		expect(() => resolveSelectedApps(apps, ["expo"])).toThrow(
			"Circular requiredApps dependency: expo -> api -> expo",
		);
	});
});

describe("buildStartPlan", () => {
	it("resolves transitive apps and unique compose services", () => {
		const apps: Record<string, AppConfig> = {
			api: {
				port: 3000,
				devCommand: "bun run api",
				requiredServices: ["postgres"],
			},
			expo: {
				port: 8081,
				devCommand: "bun run expo",
				requiredApps: ["api"],
				requiredServices: ["redis", "postgres"],
			},
		};
		const services: Record<string, ServiceConfig> = {
			postgres: {
				port: 5432,
				serviceName: "database",
			},
			redis: {
				port: 6379,
			},
		};

		const plan = buildStartPlan(apps, services, ["expo"]);

		expect(plan.appNames).toEqual(["api", "expo"]);
		expect(plan.requiredServiceKeys).toEqual(["postgres", "redis"]);
		expect(plan.composeServiceNames).toEqual(["database", "redis"]);
	});

	it("allows an app selection without required services", () => {
		const apps: Record<string, AppConfig> = {
			expo: {
				port: 8081,
				devCommand: "bun run expo",
			},
		};
		const services: Record<string, ServiceConfig> = {
			postgres: {
				port: 5432,
			},
		};

		expect(
			buildStartPlan(apps, services, ["expo"]).requiredServiceKeys,
		).toEqual([]);
	});
});

describe("getComposeServiceName", () => {
	it("uses serviceName override when present", () => {
		expect(
			getComposeServiceName(
				{
					postgres: {
						port: 5432,
						serviceName: "database",
					},
				},
				"postgres",
			),
		).toBe("database");
	});
});

describe("buildServicePlan", () => {
	it("selects the services and their Compose dependencies, and no apps", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432 },
			api: {
				port: 8080,
				docker: { image: "api", depends_on: ["postgres"] },
			},
			redis: { port: 6379 },
		};
		const plan = buildServicePlan(services, ["api"]);
		expect(plan.appNames).toEqual([]);
		expect(plan.requiredServiceKeys).toEqual(["api", "postgres"]);
	});

	it("rejects unknown services", () => {
		expect(() => buildServicePlan({}, ["nats"])).toThrow(
			"Unknown service name(s): nats",
		);
	});
});
