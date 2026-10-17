import { describe, expect, it } from "bun:test";
import { readBuncargoNextOrigins, withBuncargo } from "./index";

const DEV = "phase-development-server";
const context = { defaultConfig: {} };

describe("readBuncargoNextOrigins", () => {
	// Before Next 16.3 its own `*.localhost` matched one label; a named host has several.
	it("allows every named host, at any depth", () => {
		expect(
			readBuncargoNextOrigins(
				{ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost,192.168.1.20" },
				undefined,
			).devOrigins,
		).toEqual(["**.localhost", "192.168.1.20"]);
	});

	it("allows the tailnet address and the tunnels' hosts", () => {
		const origins = readBuncargoNextOrigins(
			{
				WEB_PUBLIC_URL: "https://quiet-river.trycloudflare.com",
				API_PUBLIC_URL: "",
				WEB_URL: "https://web.myapp.localhost",
			},
			"100.101.102.103",
		);
		expect(origins.devOrigins).toEqual([
			"100.101.102.103",
			"quiet-river.trycloudflare.com",
		]);
		expect(origins.serverActionOrigins).toEqual([
			"quiet-river.trycloudflare.com",
		]);
	});
});

describe("withBuncargo", () => {
	const env = {
		__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost",
		WEB_PUBLIC_URL: "https://quiet-river.trycloudflare.com",
	};

	it("adds the origins to `next dev`, keeping the config's own", async () => {
		const config = await withBuncargo(
			{
				reactStrictMode: true,
				allowedDevOrigins: ["preview.example.com"],
				experimental: {
					typedRoutes: true,
					serverActions: { bodySizeLimit: "2mb", allowedOrigins: ["a.com"] },
				},
			},
			{ env },
		)(DEV, context);

		expect(config.reactStrictMode).toBe(true);
		expect(config.allowedDevOrigins).toEqual(
			expect.arrayContaining(["preview.example.com", "**.localhost"]),
		);
		expect(config.experimental).toMatchObject({
			typedRoutes: true,
			serverActions: {
				bodySizeLimit: "2mb",
				allowedOrigins: ["a.com", "quiet-river.trycloudflare.com"],
			},
		});
	});

	it("leaves a production build's config alone", async () => {
		const own = { reactStrictMode: true };
		expect(
			await withBuncargo(own, { env })("phase-production-build", context),
		).toBe(own);
	});

	it("wraps a config function, passing the phase through", async () => {
		const phases: string[] = [];
		const config = await withBuncargo(
			async (phase) => {
				phases.push(phase);
				return { basePath: "/app" };
			},
			{ env },
		)(DEV, context);
		expect(phases).toEqual([DEV]);
		expect(config.basePath).toBe("/app");
		expect(config.allowedDevOrigins).toContain("**.localhost");
	});

	it("adds no Server Action origins without a tunnel", async () => {
		const own = { reactStrictMode: true };
		const config = await withBuncargo(own, { env: {} })(DEV, context);
		expect(config).not.toHaveProperty("experimental");
	});
});
