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

	it("defaults the proxy port to 443", () => {
		expect(readBuncargoViteEnvironment({}, "web").hostsPort).toBe(443);
		expect(
			readBuncargoViteEnvironment({ BUNCARGO_HOSTS_PORT: "8443" }, "web")
				.hostsPort,
		).toBe(8443);
	});
});

describe("buildBuncargoViteConfig", () => {
	// Vite's default `localhost` resolves to [::1] on many systems, and the
	// hosts proxy — plus anything else dialing IPv4 — then cannot reach it.
	it("binds loopback explicitly", () => {
		const config = buildBuncargoViteConfig(
			{ port: 4901, hostsPort: 443, allowedHosts: [] },
			"127.0.0.1",
		);
		expect(config.server.host).toBe("127.0.0.1");
		expect(config.server.port).toBe(4901);
	});

	it("points HMR at the proxy when a named host is active", () => {
		const config = buildBuncargoViteConfig(
			{
				port: 4901,
				hostname: "serpier.localhost",
				hostsPort: 443,
				allowedHosts: [".localhost"],
			},
			"127.0.0.1",
		);
		expect(config.server.hmr).toEqual({
			protocol: "wss",
			host: "serpier.localhost",
			clientPort: 443,
		});
		expect(config.server.allowedHosts).toEqual([".localhost"]);
	});

	// Without a named host the browser reaches Vite directly, and Vite's own
	// HMR defaults are already right.
	it("leaves HMR alone without a named host", () => {
		expect(
			buildBuncargoViteConfig(
				{ port: 4901, hostsPort: 443, allowedHosts: [] },
				"127.0.0.1",
			).server.hmr,
		).toBeUndefined();
	});

	it("carries a non-default proxy port into clientPort", () => {
		expect(
			buildBuncargoViteConfig(
				{
					port: 4901,
					hostname: "serpier.localhost",
					hostsPort: 8443,
					allowedHosts: [],
				},
				"127.0.0.1",
			).server.hmr?.clientPort,
		).toBe(8443);
	});

	// Omitted rather than set to undefined, so Vite falls back to its default
	// instead of seeing an explicit "no port".
	it("omits the port when none is known", () => {
		expect(
			buildBuncargoViteConfig({ hostsPort: 443, allowedHosts: [] }, "127.0.0.1")
				.server,
		).not.toHaveProperty("port");
	});
});

describe("buncargoVite", () => {
	it("resolves the app from BUNCARGO_APP_NAME", () => {
		const plugin = buncargoVite({
			env: { BUNCARGO_APP_NAME: "web", WEB_PORT: "4901" },
		});
		expect(plugin.name).toBe("buncargo");
		expect(plugin.config().server.port).toBe(4901);
	});

	it("accepts an explicit app name and host", () => {
		const config = buncargoVite({
			app: "web",
			host: "0.0.0.0",
			env: { WEB_PORT: "4901" },
		}).config();
		expect(config.server.port).toBe(4901);
		expect(config.server.host).toBe("0.0.0.0");
	});

	it("produces a usable config with an empty environment", () => {
		expect(buncargoVite({ env: {} }).config().server.host).toBe("127.0.0.1");
	});
});
