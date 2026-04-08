import { describe, expect, it } from "bun:test";
import {
	classifyCliApps,
	parseRequiredCommaSeparatedFlag,
} from "./app-selection";

describe("parseRequiredCommaSeparatedFlag", () => {
	it("parses comma-separated names", () => {
		expect(parseRequiredCommaSeparatedFlag("--apps", "api, platform")).toEqual([
			"api",
			"platform",
		]);
	});

	it("throws when the value is missing", () => {
		expect(() => parseRequiredCommaSeparatedFlag("--apps", undefined)).toThrow(
			"Flag --apps requires a comma-separated value.",
		);
	});

	it("throws when no names are provided", () => {
		expect(() => parseRequiredCommaSeparatedFlag("--apps", " , ")).toThrow(
			"Flag --apps requires at least one name.",
		);
	});
});

describe("classifyCliApps", () => {
	it("reuses busy healthy apps and starts the rest", async () => {
		const result = await classifyCliApps(
			{
				api: {
					port: 3000,
					devCommand: "bun run api",
					healthEndpoint: "/health",
				},
				web: {
					port: 3001,
					devCommand: "bun run web",
				},
			},
			{ api: 3000, web: 3001 },
			{
				isPortBusy: (port) => port === 3000,
				waitForServer: async (url) => {
					expect(url).toBe("http://localhost:3000/health");
				},
			},
		);

		expect(result.startNames).toEqual(["web"]);
		expect(result.reusedNames).toEqual(["api"]);
		expect(Object.keys(result.startApps)).toEqual(["web"]);
		expect(Object.keys(result.reusedApps)).toEqual(["api"]);
	});

	it("throws when a busy app fails its health check", async () => {
		await expect(
			classifyCliApps(
				{
					api: {
						port: 3000,
						devCommand: "bun run api",
						healthEndpoint: "/health",
					},
				},
				{ api: 3000 },
				{
					isPortBusy: () => true,
					waitForServer: async () => {
						throw new Error("unhealthy");
					},
				},
			),
		).rejects.toThrow(
			'App "api" is already listening on port 3000, but failed health check at http://localhost:3000/health. Stop the existing process or free the port before reusing it.',
		);
	});

	it("falls back to inferred reuse when no health endpoint exists", async () => {
		const result = await classifyCliApps(
			{
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
			},
			{ api: 3000 },
			{
				isPortBusy: () => true,
			},
		);

		expect(result.startNames).toEqual([]);
		expect(result.reusedNames).toEqual(["api"]);
		expect(result.inferredReuseNames).toEqual(["api"]);
	});
});
