import { expect, it } from "bun:test";
import { createDevEnvironment } from "../../environment/create-dev-environment";
import {
	buildBuncargoViteConfig,
	readBuncargoViteEnvironment,
} from "../../vite";

it("injects reachable HMR and URL context without changing loopback targets", () => {
	const env = createDevEnvironment(
		{
			projectPrefix: "demo",
			services: { redis: { port: 6379, image: "redis:7" } },
			apps: {
				web: { port: 5173, expose: true, devCommand: "bun server.ts" },
				mobile: { port: 8081, devCommand: "bunx expo start" },
			},
			env: (_, urls, ctx) => ({
				WEB_ORIGIN: ctx.publicUrls.web ?? urls.web,
				DEV_ID: ctx.workspaceId,
			}),
		},
		{ root: "/tmp/tailnet-context-test", readOnly: true },
	);
	const originalUrls = { ...env.urls };
	const urlsReference = env.urls;

	env.setTailnetUrls?.({ web: "https://devbox.tail123.ts.net:25173" });
	const vars = env.buildAppEnvVars("web");
	expect(vars.WEB_ORIGIN).toBe("https://devbox.tail123.ts.net:25173");
	expect(vars.WEB_URL).toBe(vars.WEB_ORIGIN);
	expect(env.urls.web).toBe(vars.WEB_ORIGIN);
	expect(env.urls).toBe(urlsReference);
	expect(env.urls.redis).toBe(originalUrls.redis);
	expect(vars.DEV_ID).toBe(env.workspaceId ?? "missing");
	expect(env.buildAppEnvVars("mobile").EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID).toBe(
		vars.BUNCARGO_WORKSPACE_ID,
	);
	expect(env.loopbackUrls.web).toContain("localhost");
	const vite = buildBuncargoViteConfig(
		readBuncargoViteEnvironment(vars, "web"),
		"127.0.0.1",
	);
	expect(vite.server.hmr).toEqual({
		host: "devbox.tail123.ts.net",
		protocol: "wss",
		clientPort: 25173,
	});
	expect(vite.server.port).toBe(env.ports.web);
	expect(vite.server.allowedHosts).toEqual(["devbox.tail123.ts.net"]);

	env.setPublicUrls({ web: "https://public.example.test" });
	expect(env.buildAppEnvVars("web").WEB_ORIGIN).toBe(
		"https://public.example.test",
	);
	env.clearPublicUrls();

	env.setTailnetUrls?.({});
	expect(env.urls).toEqual(originalUrls);
	expect(env.buildAppEnvVars("web").WEB_ORIGIN).toBe(originalUrls.web);
});

it("preserves remote URLs across local host changes and restores local aliases when cleared", () => {
	const env = createDevEnvironment(
		{
			projectPrefix: "demo",
			services: { redis: { port: 6379, image: "redis:7" } },
			apps: { web: { port: 5173, expose: true, devCommand: "bun server.ts" } },
			options: { hosts: { primaryApp: "web" } },
		},
		{ root: "/tmp/tailnet-context-test", readOnly: true },
	);
	const redisUrl = env.urls.redis;
	env.setNamedHostsActive(true);
	const localUrl = env.urls.web;

	env.setTailnetUrls?.({
		web: "https://devbox.tail123.ts.net:25173",
		redis: "https://invalid.example",
	});
	env.setNamedHostsActive(false);
	expect(env.urls.web).toBe("https://devbox.tail123.ts.net:25173");
	expect(env.urls.redis).toBe(redisUrl);
	env.setNamedHostsActive(true);
	expect(env.urls.web).toBe("https://devbox.tail123.ts.net:25173");

	env.setTailnetUrls?.({});
	expect(env.urls.web).toBe(localUrl);
});
