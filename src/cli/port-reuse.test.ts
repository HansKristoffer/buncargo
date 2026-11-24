import { describe, expect, it } from "bun:test";
import { resolveApps } from "../config/resolve";
import { fakeRuntime } from "../container-runtime/fake-runtime.testing";
import { classifyCliApps, type UnhealthyHolder } from "./port-reuse";

describe("classifyCliApps", () => {
	it("reuses busy healthy apps and starts the rest", async () => {
		const result = await classifyCliApps(
			resolveApps({
				api: {
					port: 3000,
					devCommand: "bun run api",
					healthEndpoint: "/health",
				},
				web: {
					port: 3001,
					devCommand: "bun run web",
				},
			}),
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
				resolveApps({
					api: {
						port: 3000,
						devCommand: "bun run api",
						healthEndpoint: "/health",
					},
				}),
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

	const unhealthyWeb = (holder: UnhealthyHolder) =>
		classifyCliApps(
			resolveApps({
				web: { port: 4321, devCommand: "bun run dev", healthEndpoint: "/" },
			}),
			{ web: 4321 },
			{
				isPortBusy: () => true,
				waitForServer: async () => {
					throw new Error("unhealthy");
				},
				inspectUnhealthyHolder: async () => holder,
			},
		);

	it("starts an unhealthy app once its leftover holder was stopped", async () => {
		const result = await unhealthyWeb("stopped");

		expect(result.startNames).toEqual(["web"]);
		expect(result.reusedNames).toEqual([]);
		expect(result.unhealthy).toEqual([]);
	});

	it("reports an unhealthy app a sibling run serves", async () => {
		const result = await unhealthyWeb({ detached: true });

		expect(result.reusedNames).toEqual(["web"]);
		expect(result.unhealthy).toEqual([
			{
				name: "web",
				port: 4321,
				url: "http://localhost:4321/",
				detached: true,
			},
		]);
	});

	it("still throws when the unhealthy holder is not this checkout's", async () => {
		await expect(unhealthyWeb(undefined)).rejects.toThrow(
			'App "web" is already listening on port 4321',
		);
	});

	it("refuses to reuse a port owned by another compose project", async () => {
		await expect(
			classifyCliApps(
				resolveApps({
					api: {
						port: 3000,
						devCommand: "bun run api",
						healthEndpoint: "/health",
					},
				}),
				{ api: 3000 },
				{
					isPortBusy: () => true,
					waitForServer: async () => {},
					describePortConflict: () =>
						"port 3000 held by container other-api-1 (project other)",
				},
			),
		).rejects.toThrow(
			'App "api" cannot use port 3000: port 3000 held by container other-api-1 (project other).',
		);
	});

	it("falls back to inferred reuse when no health endpoint exists", async () => {
		const result = await classifyCliApps(
			resolveApps({
				api: {
					port: 3000,
					devCommand: "bun run api",
				},
			}),
			{ api: 3000 },
			{
				isPortBusy: () => true,
			},
		);

		expect(result.startNames).toEqual([]);
		expect(result.reusedNames).toEqual(["api"]);
		expect(result.inferredReuseNames).toEqual(["api"]);
	});

	it("skips the live port/container snapshot when predicates are injected", async () => {
		let containerReads = 0;
		const result = await classifyCliApps(
			resolveApps({
				api: { port: 3000, devCommand: "bun run api" },
			}),
			{ api: 3000 },
			{
				isPortBusy: () => false,
				runtime: fakeRuntime({
					containers: async () => {
						containerReads += 1;
						return [];
					},
				}),
			},
		);

		expect(containerReads).toBe(0);
		expect(result.startNames).toEqual(["api"]);
		expect(result.portOwners).toBeUndefined();
	});
});
