import { describe, expect, it } from "bun:test";
import {
	applyHostPlanToUrls,
	isHttpService,
	planNamedHosts,
	sanitizeDnsLabel,
	sanitizeTld,
} from "./plan";

describe("sanitizeDnsLabel", () => {
	it("lowercases and strips illegal characters", () => {
		expect(sanitizeDnsLabel("Feature_A")).toBe("feature-a");
	});

	it("rejects reserved CLI names", () => {
		expect(() => sanitizeDnsLabel("hosts")).toThrow(/reserved/);
	});

	it("rejects an empty result", () => {
		expect(() => sanitizeDnsLabel("***")).toThrow(/not a valid DNS label/);
	});
});

describe("sanitizeTld", () => {
	it("accepts localhost and multi-label names", () => {
		expect(sanitizeTld("localhost")).toBe("localhost");
		expect(sanitizeTld("dev.example.com")).toBe("dev.example.com");
	});

	it("rejects illegal labels", () => {
		expect(() => sanitizeTld("-bad")).toThrow(/not a valid DNS name/);
	});
});

describe("isHttpService", () => {
	it("treats postgres and redis as TCP", () => {
		expect(isHttpService("postgres", { port: 5432 })).toBe(false);
		expect(isHttpService("redis", { port: 6379 })).toBe(false);
	});

	it("treats mailpit and typesense as HTTP", () => {
		expect(isHttpService("mailpit", { port: 8025 })).toBe(true);
		expect(isHttpService("typesense", { port: 8108 })).toBe(true);
	});

	it("uses the docker preset when the key is custom", () => {
		expect(
			isHttpService("db", {
				port: 5432,
				docker: { kind: "preset", preset: "postgres" },
			}),
		).toBe(false);
	});
});

describe("planNamedHosts", () => {
	const services = {
		postgres: { port: 5432 },
		mailpit: { port: 8025 },
		typesense: { port: 8108 },
	};
	const apps = {
		web: { port: 3001, devCommand: "vite" },
		api: { port: 3000, devCommand: "bun run api" },
	};
	const ports = {
		postgres: 5432,
		mailpit: 8025,
		typesense: 8108,
		web: 3001,
		api: 3000,
	};

	it("names apps and default HTTP services on the main checkout", () => {
		const plan = planNamedHosts({
			projectPrefix: "serpier",
			apps,
			services,
			ports,
			hosts: true,
		});
		expect(plan).toEqual([
			{
				kind: "app",
				name: "web",
				hostname: "web.serpier.localhost",
				targetPort: 3001,
			},
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				targetPort: 3000,
			},
			{
				kind: "service",
				name: "mailpit",
				hostname: "mailpit.serpier.localhost",
				targetPort: 8025,
			},
			{
				kind: "service",
				name: "typesense",
				hostname: "typesense.serpier.localhost",
				targetPort: 8108,
			},
		]);
	});

	it("prefixes worktree directory names, not git branches", () => {
		const plan = planNamedHosts({
			projectPrefix: "serpier",
			worktreeSuffix: "fix-ui",
			apps,
			services,
			ports,
			hosts: true,
		});
		expect(plan.find((entry) => entry.name === "api")?.hostname).toBe(
			"fix-ui.api.serpier.localhost",
		);
		expect(plan.find((entry) => entry.name === "mailpit")?.hostname).toBe(
			"fix-ui.mailpit.serpier.localhost",
		);
	});

	it("collapses primaryApp to the bare project hostname", () => {
		const plan = planNamedHosts({
			projectPrefix: "serpier",
			apps,
			services,
			ports,
			hosts: { primaryApp: "web" },
		});
		expect(plan.find((entry) => entry.name === "web")?.hostname).toBe(
			"serpier.localhost",
		);
		expect(plan.find((entry) => entry.name === "api")?.hostname).toBe(
			"api.serpier.localhost",
		);
	});

	it("collapses primaryApp under a worktree", () => {
		const plan = planNamedHosts({
			projectPrefix: "serpier",
			worktreeSuffix: "fix-ui",
			apps,
			services,
			ports,
			hosts: { primaryApp: "web" },
		});
		expect(plan.find((entry) => entry.name === "web")?.hostname).toBe(
			"fix-ui.serpier.localhost",
		);
	});

	it("does not name TCP services even when services is true", () => {
		const plan = planNamedHosts({
			projectPrefix: "serpier",
			apps,
			services,
			ports,
			hosts: { services: true },
		});
		expect(plan.some((entry) => entry.name === "postgres")).toBe(false);
	});

	it("uses a custom multi-label TLD", () => {
		const plan = planNamedHosts({
			projectPrefix: "serpier",
			apps: { api: apps.api },
			services: { postgres: services.postgres },
			ports,
			hosts: { tld: "dev.example.com", services: [] },
		});
		expect(plan[0]?.hostname).toBe("api.serpier.dev.example.com");
	});
});

describe("applyHostPlanToUrls", () => {
	it("rewrites matching keys to https hostnames", () => {
		const urls = {
			api: "http://localhost:3000",
			postgres: "postgresql://postgres:postgres@localhost:5432/postgres",
		};
		applyHostPlanToUrls(urls, [
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				targetPort: 3000,
			},
		]);
		expect(urls.api).toBe("https://api.serpier.localhost");
		expect(urls.postgres).toContain("postgresql://");
	});
});
