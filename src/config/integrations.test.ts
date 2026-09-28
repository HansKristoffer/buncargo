import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { expo } from "../expo";
import type { BuncargoIntegration, IntegrationConfig } from "../types";
import { applyIntegrations, resetLegacyExpoWarning } from "./integrations";
import { mergeConfigs } from "./merge-configs";
import { validateConfig } from "./validate-config";

const base: IntegrationConfig = {
	projectPrefix: "shop",
	services: {},
	apps: { api: { port: 3000, devCommand: "bun dev" } },
};

function adding(name: string, app: string): BuncargoIntegration {
	return {
		name,
		config: (config) =>
			mergeConfigs(config, {
				apps: { ...config.apps, [app]: { port: 4000, devCommand: "x" } },
			}),
	};
}

describe("applyIntegrations", () => {
	beforeEach(() => resetLegacyExpoWarning());

	it("applies each config transform in order and keeps the integrations", () => {
		const order: string[] = [];
		const first: BuncargoIntegration = {
			name: "first",
			config: (config) => {
				order.push("first");
				return config;
			},
		};
		const resolved = applyIntegrations({
			...base,
			integrations: [first, adding("second", "web")],
		});
		expect(order).toEqual(["first"]);
		expect(Object.keys(resolved.apps ?? {})).toEqual(["api", "web"]);
		expect(resolved.integrations?.map((entry) => entry.name)).toEqual([
			"first",
			"second",
		]);
		// Idempotent: a resolved config is not transformed twice.
		expect(applyIntegrations(resolved)).toBe(resolved);
	});

	it("runs the config's hooks first, then each integration's", async () => {
		const calls: string[] = [];
		const resolved = applyIntegrations({
			...base,
			hooks: {
				beforeServers: async () => {
					calls.push("config");
				},
			},
			integrations: [
				{
					name: "one",
					hooks: {
						beforeServers: async () => {
							calls.push("one");
						},
					},
				},
				{
					name: "two",
					hooks: {
						beforeServers: async () => {
							calls.push("two");
						},
					},
				},
			],
		});
		const hook = resolved.hooks?.beforeServers as (
			ctx: unknown,
		) => Promise<void>;
		await hook({});
		expect(calls).toEqual(["config", "one", "two"]);
	});

	it("appends integration checks after the config's", () => {
		const resolved = applyIntegrations({
			...base,
			checks: [{ name: "own", check: () => true }],
			integrations: [
				{ name: "shop", checks: [{ name: "theirs", check: () => true }] },
			],
		});
		expect(resolved.checks?.map((check) => check.name)).toEqual([
			"own",
			"theirs",
		]);
	});

	it("names the integration whose transform throws", () => {
		expect(() =>
			applyIntegrations({
				...base,
				integrations: [
					{
						name: "broken",
						config: () => {
							throw new Error("no toml");
						},
					},
				],
			}),
		).toThrow('Integration "broken" failed to apply: no toml');
	});

	// The deprecated alias: a config written before integrations still works.
	it("adds expo() for the legacy expo field, with one warning", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const legacy = {
				...base,
				apps: {
					mobile: { port: 8081, devCommand: "bun start", expo: true },
				},
			};
			const resolved = applyIntegrations(legacy);
			applyIntegrations({ ...legacy });
			expect(resolved.integrations?.map((entry) => entry.name)).toEqual([
				"expo",
			]);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("leaves a config without Expo alone", () => {
		expect(applyIntegrations(base)).toBe(base);
	});
});

describe("validateConfig with integrations", () => {
	it("validates what an integration adds", () => {
		const errors = validateConfig({
			...base,
			integrations: [
				{
					name: "bad",
					config: (config: IntegrationConfig) => ({
						...config,
						apps: { ...config.apps, web: { port: 3000, devCommand: "x" } },
					}),
				},
			],
		});
		expect(errors).toContain(
			"apps.web.port duplicates port 3000 used by apps.api.port",
		);
	});

	it("lets profiles name an app an integration adds", () => {
		expect(
			validateConfig({
				...base,
				integrations: [adding("shop", "shopify")],
				profiles: { default: { apps: ["shopify"] } },
			}),
		).toEqual([]);
	});

	it("rejects malformed integrations", () => {
		expect(
			validateConfig({ ...base, integrations: [{ name: "Bad Name" }] }),
		).toEqual(["integrations.0.name must be a lowercase name"]);
	});
});

describe("expo()", () => {
	it("gives its apps Metro's port and the workspace id, and a registry field", () => {
		const integration = expo({ apps: { mobile: { scheme: "shop" } } });
		integration.config?.({
			...base,
			apps: { mobile: { port: 8081, devCommand: "bunx expo start" } },
		});
		const app = {
			name: "mobile",
			config: { port: 8081, devCommand: "bunx expo start" },
			port: 8181,
			root: "/nonexistent",
			workspaceId: "ws-1",
		};
		expect(integration.appEnv?.(app)).toEqual({
			EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID: "ws-1",
			RCT_METRO_PORT: "8181",
		});
		expect(integration.describeApp?.(app)).toEqual({
			expo: { scheme: "shop" },
		});
		expect(integration.appEnv?.({ ...app, name: "api" })).toBeUndefined();
		expect(integration.commands?.sim).toBeDefined();
	});

	it("infers Expo apps from their devCommand by default", () => {
		const integration = expo();
		integration.config?.({
			...base,
			apps: {
				api: { port: 3000, devCommand: "bun dev" },
				mobile: { port: 8081, devCommand: "bunx expo start" },
			},
		});
		expect(integration.appOptions("mobile")).toEqual({});
		expect(integration.appOptions("api")).toBeUndefined();
	});

	it("rejects an app that is not configured", () => {
		expect(() => expo({ apps: ["nope"] }).config?.(base)).toThrow(
			'"nope" is not a configured app',
		);
	});
});
