import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../types";
import { configuredPrimaryApp, resolvePrimaryApp } from "./primary-app";

const apps: Record<string, AppConfig> = {
	api: { port: 3000, devCommand: "bun dev" },
	web: { port: 5173, devCommand: "bun dev", requiredApps: ["api"] },
	admin: { port: 5174, devCommand: "bun dev", requiredApps: ["api"] },
};

describe("resolvePrimaryApp", () => {
	it("prefers the explicit option", () => {
		expect(resolvePrimaryApp({ apps, options: { primaryApp: "api" } })).toBe(
			"api",
		);
	});

	it("falls back to hosts.primaryApp", () => {
		expect(
			resolvePrimaryApp({ apps, options: { hosts: { primaryApp: "admin" } } }),
		).toBe("admin");
	});

	it("falls back to frontendApp", () => {
		expect(resolvePrimaryApp({ apps, options: { frontendApp: "admin" } })).toBe(
			"admin",
		);
	});

	// An API + web project: nothing depends on the web app, so that is the one
	// someone clicking "open" wants.
	it("infers the dependency root when nothing is configured", () => {
		expect(resolvePrimaryApp({ apps, selected: ["api", "web"] })).toBe("web");
	});

	it("narrows to the running set", () => {
		expect(resolvePrimaryApp({ apps, selected: ["api"] })).toBe("api");
	});

	// Pointing "open" at an app this run did not start is worse than falling
	// through to one it did.
	it("ignores a configured app that is not running", () => {
		expect(
			resolvePrimaryApp({
				apps,
				options: { primaryApp: "web" },
				selected: ["api"],
			}),
		).toBe("api");
	});

	it("returns nothing when there are no apps", () => {
		expect(resolvePrimaryApp({ apps: {} })).toBeUndefined();
	});
});

describe("configuredPrimaryApp", () => {
	// Named hostnames read this: inferring a new owner for the bare
	// `myapp.localhost` would silently move a name people have bookmarked.
	it("never infers", () => {
		expect(configuredPrimaryApp({})).toBeUndefined();
		expect(configuredPrimaryApp({ hosts: true })).toBeUndefined();
	});
});
