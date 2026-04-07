import { describe, expect, it } from "bun:test";
import type { AppConfig } from "../types";
import { assertOnlyAppNames, pickApps } from "./only-apps";

describe("assertOnlyAppNames", () => {
	it("allows undefined onlyApps", () => {
		expect(() => assertOnlyAppNames(["api"], undefined)).not.toThrow();
	});

	it("throws for unknown names", () => {
		expect(() => assertOnlyAppNames(["api"], ["missing"])).toThrow(
			/Unknown app name\(s\) in onlyApps: missing/,
		);
	});
});

describe("pickApps", () => {
	const apps = {
		api: { port: 3000, devCommand: "bun dev" },
		web: { port: 5173, devCommand: "bun dev" },
	} as Record<string, AppConfig>;

	it("returns full apps when onlyApps is undefined", () => {
		expect(pickApps(apps, undefined)).toBe(apps);
	});

	it("returns only named apps", () => {
		const subset = pickApps(apps, ["api"]);
		expect(Object.keys(subset)).toEqual(["api"]);
		expect(subset.api).toBe(apps.api);
	});

	it("returns empty when onlyApps is empty", () => {
		expect(Object.keys(pickApps(apps, []))).toEqual([]);
	});
});
