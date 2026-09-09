import { describe, expect, it } from "bun:test";
import {
	buildBuncargoViteConfig,
	buncargoVite,
	readBuncargoViteEnvironment,
} from "./index";

describe("readBuncargoViteEnvironment", () => {
	it("reads the port buncargo injected", () => {
		expect(readBuncargoViteEnvironment({ PORT: "4901" }, "web").port).toBe(
			4901,
		);
	});

	// A Vite process started by hand still has the shared env but no PORT.
	it("falls back to <APP>_PORT", () => {
		expect(readBuncargoViteEnvironment({ WEB_PORT: "4901" }, "web").port).toBe(
			4901,
		);
	});

	it("ignores a non-numeric port", () => {
		expect(
			readBuncargoViteEnvironment({ PORT: "abc" }, "web").port,
		).toBeUndefined();
	});

	it("splits the allowed-hosts list", () => {
		expect(
			readBuncargoViteEnvironment(
				{ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost, .test" },
				"web",
			).allowedHosts,
		).toEqual([".localhost", ".test"]);
	});

	it("has no allowed hosts when none are injected", () => {
		expect(readBuncargoViteEnvironment({}, "web").allowedHosts).toEqual([]);
	});
});

describe("buildBuncargoViteConfig", () => {
	// Vite's default `localhost` resolves to [::1] on many systems, and the
	// hosts proxy — plus anything else dialing IPv4 — then cannot reach it.
	it("binds loopback explicitly", () => {
		const config = buildBuncargoViteConfig(
			{ port: 4901, allowedHosts: [] },
			"127.0.0.1",
		);
		expect(config.server.host).toBe("127.0.0.1");
		expect(config.server.port).toBe(4901);
	});

	it("lets HMR follow either the local or remote page origin", async () => {
		const config = await buncargoVite({
			env: {
				PORT: "4901",
				BUNCARGO_APP_HOSTNAME: "project.localhost",
				BUNCARGO_HOSTS_PORT: "8443",
				__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: ".localhost",
			},
		}).config({}, { command: "build" });
		expect(config.server).not.toHaveProperty("hmr");
		expect(config.server.allowedHosts).toEqual([".localhost"]);
	});

	// Omitted rather than set to undefined, so Vite falls back to its default
	// instead of seeing an explicit "no port".
	it("omits the port when none is known", () => {
		expect(
			buildBuncargoViteConfig({ allowedHosts: [] }, "127.0.0.1").server,
		).not.toHaveProperty("port");
	});
});

describe("buncargoVite", () => {
	it("resolves the app from BUNCARGO_APP_NAME", async () => {
		const plugin = buncargoVite({
			env: { BUNCARGO_APP_NAME: "web", WEB_PORT: "4901" },
		});
		expect(plugin.name).toBe("buncargo");
		expect((await plugin.config({}, { command: "build" })).server.port).toBe(
			4901,
		);
	});

	it("accepts an explicit app name and host", async () => {
		const config = await buncargoVite({
			app: "web",
			host: "0.0.0.0",
			env: { WEB_PORT: "4901" },
		}).config({}, { command: "build" });
		expect(config.server.port).toBe(4901);
		expect(config.server.host).toBe("0.0.0.0");
	});

	it("produces a usable config with an empty environment", async () => {
		expect(
			(await buncargoVite({ env: {} }).config({}, { command: "build" })).server
				.host,
		).toBe("127.0.0.1");
	});
});
