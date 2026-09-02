import { describe, expect, it } from "bun:test";
import type { NamedHost } from "../../types";
import {
	applyHostPlanToUrls,
	certificateCovers,
	certificateHostnames,
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
				baseHostname: "web.serpier.localhost",
				targetPort: 3001,
			},
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				baseHostname: "api.serpier.localhost",
				targetPort: 3000,
			},
			{
				kind: "service",
				name: "mailpit",
				hostname: "mailpit.serpier.localhost",
				baseHostname: "mailpit.serpier.localhost",
				targetPort: 8025,
			},
			{
				kind: "service",
				name: "typesense",
				hostname: "typesense.serpier.localhost",
				baseHostname: "typesense.serpier.localhost",
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
				baseHostname: "api.serpier.localhost",
				targetPort: 3000,
			},
		]);
		expect(urls.api).toBe("https://api.serpier.localhost");
		expect(urls.postgres).toContain("postgresql://");
	});
});

/**
 * The churn this exists to remove: a new worktree adds a label in front of
 * every hostname, so each fresh checkout used to force a remint — and a remint
 * rebinds the daemon, dropping every proxied websocket on the machine.
 */
describe("certificateHostnames", () => {
	/** A plan entry as `planNamedHosts` builds it: base name plus the checkout's own. */
	const app = (baseHostname: string, worktree?: string): NamedHost => ({
		kind: "app",
		name: "api",
		hostname: worktree ? `${worktree}.${baseHostname}` : baseHostname,
		baseHostname,
		targetPort: 3000,
	});

	it("keeps the exact hostnames", () => {
		expect(
			certificateHostnames([app("api.myapp.localhost")], "localhost"),
		).toContain("api.myapp.localhost");
	});

	// A wildcard matches exactly one label, so covering a worktree of this
	// hostname and a worktree of a sibling are two different names.
	it("covers a future worktree of this hostname and of its siblings", () => {
		expect(
			certificateHostnames([app("api.myapp.localhost")], "localhost"),
		).toEqual([
			"*.api.myapp.localhost",
			"*.myapp.localhost",
			"api.myapp.localhost",
		]);
	});

	it("stops above the TLD, never emitting a wildcard for it", () => {
		const names = certificateHostnames(
			[app("api.myapp.localhost"), app("myapp.localhost")],
			"localhost",
		);
		expect(names).not.toContain("*.localhost");
	});

	it("respects a multi-label TLD", () => {
		const names = certificateHostnames(
			[app("api.myapp.dev.example.com")],
			"dev.example.com",
		);
		expect(names).toContain("*.api.myapp.dev.example.com");
		expect(names).toContain("*.myapp.dev.example.com");
		expect(names).not.toContain("*.dev.example.com");
	});

	// The whole point: a worktree asks for exactly what the main checkout
	// already asked for, so its first run mints nothing.
	it("asks for the same names from a worktree as from the main checkout", () => {
		const main = certificateHostnames(
			[app("api.myapp.localhost"), app("myapp.localhost")],
			"localhost",
		);
		const worktree = certificateHostnames(
			[app("api.myapp.localhost", "fix-ui"), app("myapp.localhost", "fix-ui")],
			"localhost",
		);
		expect(worktree).toEqual(main);
	});

	it("covers the worktree's actual hostnames with those names", () => {
		const main = certificateHostnames(
			[app("api.myapp.localhost"), app("myapp.localhost")],
			"localhost",
		);
		for (const hostname of [
			"fix-ui.api.myapp.localhost",
			"fix-ui.myapp.localhost",
		]) {
			expect(certificateCovers(main, hostname)).toBe(true);
		}
	});

	it("deduplicates across a plan", () => {
		const names = certificateHostnames(
			[app("api.myapp.localhost"), app("web.myapp.localhost")],
			"localhost",
		);
		expect(names.filter((name) => name === "*.myapp.localhost")).toHaveLength(
			1,
		);
	});
});

describe("certificateCovers", () => {
	it("matches an exact name", () => {
		expect(
			certificateCovers(["api.myapp.localhost"], "api.myapp.localhost"),
		).toBe(true);
	});

	it("matches one label under a wildcard", () => {
		expect(
			certificateCovers(["*.myapp.localhost"], "api.myapp.localhost"),
		).toBe(true);
	});

	// The rule browsers apply: a wildcard is one label, not a suffix match.
	it("does not let a wildcard span two labels", () => {
		expect(
			certificateCovers(["*.myapp.localhost"], "fix-ui.api.myapp.localhost"),
		).toBe(false);
	});

	it("does not match a different domain", () => {
		expect(
			certificateCovers(["*.myapp.localhost"], "api.other.localhost"),
		).toBe(false);
	});

	it("handles a single-label name", () => {
		expect(certificateCovers(["*.myapp.localhost"], "localhost")).toBe(false);
		expect(certificateCovers(["localhost"], "localhost")).toBe(true);
	});
});
