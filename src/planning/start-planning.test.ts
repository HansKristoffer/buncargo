import { describe, expect, it } from "bun:test";
import { resolveApps, resolveServices } from "../config/resolve";
import {
	buildServicePlan,
	buildStartPlan,
	getComposeServiceName,
	resolveSelectedApps,
} from "./start-planning";

describe("resolveSelectedApps", () => {
	it("expands selected apps through transitive requiredApps", () => {
		const apps = resolveApps({
			api: {
				port: 3000,
				devCommand: "bun run api",
			},
			expo: {
				port: 8081,
				devCommand: "bun run expo",
				requiredApps: ["api"],
			},
		});

		const plan = resolveSelectedApps(apps, ["expo"]);

		expect(plan.appNames).toEqual(["api", "expo"]);
		expect(Object.keys(plan.apps)).toEqual(["api", "expo"]);
	});

	it("throws for circular requiredApps", () => {
		const apps = resolveApps({
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
		});

		expect(() => resolveSelectedApps(apps, ["expo"])).toThrow(
			"Circular requiredApps dependency: expo -> api -> expo",
		);
	});
});

describe("buildStartPlan", () => {
	it("resolves transitive apps and unique compose services", () => {
		const apps = resolveApps({
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
		});
		const services = resolveServices({
			postgres: {
				port: 5432,
				serviceName: "database",
			},
			redis: {
				port: 6379,
			},
		});

		const plan = buildStartPlan(apps, services, ["expo"]);

		expect(plan.appNames).toEqual(["api", "expo"]);
		expect(plan.requiredServiceKeys).toEqual(["postgres", "redis"]);
		expect(plan.composeServiceNames).toEqual(["database", "redis"]);
	});

	it("allows an app selection without required services", () => {
		const apps = resolveApps({
			expo: {
				port: 8081,
				devCommand: "bun run expo",
			},
		});
		const services = resolveServices({
			postgres: {
				port: 5432,
			},
		});

		expect(
			buildStartPlan(apps, services, ["expo"]).requiredServiceKeys,
		).toEqual([]);
	});
});

describe("a config with services and no apps", () => {
	it("starts every service", () => {
		const services = resolveServices({
			postgres: { port: 5432 },
			redis: { port: 6379 },
		});
		expect(
			buildStartPlan(resolveApps({}), services, undefined).requiredServiceKeys,
		).toEqual(["postgres", "redis"]);
	});

	it("still starts nothing for apps that require nothing", () => {
		expect(
			buildStartPlan(
				resolveApps({ web: { port: 3000, devCommand: "bun dev" } }),
				resolveServices({ postgres: { port: 5432 } }),
				undefined,
			).requiredServiceKeys,
		).toEqual([]);
	});
});

describe("getComposeServiceName", () => {
	it("uses serviceName override when present", () => {
		expect(
			getComposeServiceName(
				resolveServices({
					postgres: {
						port: 5432,
						serviceName: "database",
					},
				}),
				"postgres",
			),
		).toBe("database");
	});
});

describe("buildServicePlan", () => {
	it("selects the services and their Compose dependencies, and no apps", () => {
		const services = resolveServices({
			postgres: { port: 5432 },
			api: {
				port: 8080,
				docker: { image: "api", depends_on: ["postgres"] },
			},
			redis: { port: 6379 },
		});
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
