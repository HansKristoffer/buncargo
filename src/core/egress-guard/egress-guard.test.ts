import { afterEach, describe, expect, it } from "bun:test";
import {
	createServer as createNetServer,
	connect as netConnect,
} from "node:net";
import { createDevEnvironment } from "../../environment";
import { startFakeInfisical } from "../secrets/fake-infisical.testing";
import { clearScopeSecretsCache } from "../secrets/index";
import { freePorts, useTempHome } from "../test-env.testing";
import {
	allowedHostsOf,
	type BlockedEgressEvent,
	buildNoProxyList,
	type EgressGuardProxy,
	egressGuardEnv,
	guardsApp,
	isHostAllowed,
	isLoopbackHost,
	parseConnectAuthority,
	resolveEgressGuard,
	startEgressGuardProxy,
	supportsNodeEnvProxy,
} from "./index";

const home = useTempHome();
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

describe("egressGuard rules", () => {
	it("merges base and profile egressGuard settings cleanly", () => {
		expect(resolveEgressGuard(undefined, undefined)).toBeUndefined();
		expect(resolveEgressGuard(true, undefined)).toEqual({
			enabled: true,
			allow: [],
			allowHostsOf: [],
			mode: "block",
		});
		expect(resolveEgressGuard(true, false)).toBeUndefined();
		expect(
			resolveEgressGuard(
				{ allow: ["a.example.com"], apps: ["api"] },
				{ mode: "warn" },
			),
		).toEqual({
			enabled: true,
			allow: ["a.example.com"],
			allowHostsOf: [],
			mode: "warn",
			apps: ["api"],
		});
		expect(
			resolveEgressGuard(
				{ allow: ["a.example.com"] },
				{ allow: ["b.example.com"], mode: "warn", apps: ["api"] },
			),
		).toEqual({
			enabled: true,
			allow: ["b.example.com"],
			allowHostsOf: [],
			mode: "warn",
			apps: ["api"],
		});
		expect(
			resolveEgressGuard({ allowHostsOf: ["UNLEASH_URL"] }, { mode: "warn" }),
		).toMatchObject({ allowHostsOf: ["UNLEASH_URL"], mode: "warn" });
		expect(
			resolveEgressGuard(
				{ allowHostsOf: ["UNLEASH_URL"] },
				{ allowHostsOf: ["OTHER_URL"] },
			),
		).toMatchObject({ allowHostsOf: ["OTHER_URL"] });
	});

	it("reads allowHostsOf hosts from URL values and names the keys without one", () => {
		expect(
			allowedHostsOf(
				["UNLEASH", "SAME", "MISSING", "BARE", "EMPTY", "PATTERN", "V6"],
				{
					UNLEASH: "https://Unleash.Example.com/api",
					SAME: "https://unleash.example.com:4242/other",
					BARE: "unleash.example.com",
					EMPTY: "",
					PATTERN: "https://*.com/",
					V6: "http://[2001:db8::5]:8080/",
				},
			),
		).toEqual({
			hosts: ["unleash.example.com", "2001:db8::5"],
			unresolved: ["MISSING", "BARE", "EMPTY", "PATTERN"],
		});
	});

	it("matches loopback, private RFC1918/ULA, exact host, host:port, trailing dots, and leading wildcards", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("api.kanpla.localhost")).toBe(true);
		expect(isLoopbackHost("api.stripe.com")).toBe(false);

		const allow = [
			"app.unleash-hosted.com",
			"*.storage.googleapis.com",
			"*.example.com:8443",
			"custom.internal:8443",
		];
		expect(isHostAllowed("localhost", 8080, [])).toBe(true);
		expect(isHostAllowed("10.0.0.5", 443, [])).toBe(true);
		expect(isHostAllowed("172.16.4.2", 443, [])).toBe(true);
		expect(isHostAllowed("172.32.0.1", 443, [])).toBe(false);
		expect(isHostAllowed("192.168.1.42", 8080, [])).toBe(true);
		expect(isHostAllowed("169.254.1.10", 80, [])).toBe(true);
		expect(isHostAllowed("fd00::1", 443, [])).toBe(true);
		expect(isHostAllowed("app.unleash-hosted.com", 443, allow)).toBe(true);
		expect(isHostAllowed("APP.UNLEASH-HOSTED.COM.", 443, allow)).toBe(true);
		expect(isHostAllowed("foo.storage.googleapis.com.", 443, allow)).toBe(true);
		expect(isHostAllowed("sub.example.com", 8443, allow)).toBe(true);
		expect(isHostAllowed("sub.example.com", 443, allow)).toBe(false);
		expect(isHostAllowed("custom.internal", 8443, allow)).toBe(true);
		expect(isHostAllowed("custom.internal", 443, allow)).toBe(false);
		expect(isHostAllowed("api.mailjet.com", 443, allow)).toBe(false);
	});

	it("builds deduplicated NO_PROXY lists and proxy env vars", () => {
		const noProxy = buildNoProxyList([".dev.local", "localhost"]);
		expect(noProxy).toBe("localhost,127.0.0.1,::1,.localhost,.dev.local");
		expect(egressGuardEnv("http://127.0.0.1:9999", noProxy)).toEqual({
			HTTP_PROXY: "http://127.0.0.1:9999",
			HTTPS_PROXY: "http://127.0.0.1:9999",
			http_proxy: "http://127.0.0.1:9999",
			https_proxy: "http://127.0.0.1:9999",
			grpc_proxy: "http://127.0.0.1:9999",
			NO_PROXY: noProxy,
			no_proxy: noProxy,
			NODE_USE_ENV_PROXY: "1",
		});
		expect(
			guardsApp(
				{
					enabled: true,
					allow: [],
					allowHostsOf: [],
					mode: "block",
					apps: ["api"],
				},
				"api",
			),
		).toBe(true);
		expect(
			guardsApp(
				{
					enabled: true,
					allow: [],
					allowHostsOf: [],
					mode: "block",
					apps: ["api"],
				},
				"web",
			),
		).toBe(false);
	});

	it("checks Node NODE_USE_ENV_PROXY version thresholds", () => {
		expect(supportsNodeEnvProxy("v22.21.0")).toBe(true);
		expect(supportsNodeEnvProxy("22.20.9")).toBe(false);
		expect(supportsNodeEnvProxy("v24.5.0")).toBe(true);
		expect(supportsNodeEnvProxy("v24.4.1")).toBe(false);
		expect(supportsNodeEnvProxy("v25.0.0")).toBe(true);
		expect(supportsNodeEnvProxy("v23.11.0")).toBe(false);
	});

	it("parses CONNECT authorities including IPv6", () => {
		expect(parseConnectAuthority("api.stripe.com:443")).toEqual({
			host: "api.stripe.com",
			port: 443,
		});
		expect(parseConnectAuthority("[::1]:8080")).toEqual({
			host: "::1",
			port: 8080,
		});
		expect(parseConnectAuthority("bad:notaport")).toBeUndefined();
		expect(parseConnectAuthority("api.stripe.com:443abc")).toBeUndefined();
		expect(parseConnectAuthority("api.stripe.com:70000")).toBeUndefined();
		expect(parseConnectAuthority("api.stripe.com:0")).toBeUndefined();
	});
});

describe("egressGuard proxy", () => {
	async function sendRaw(port: number, payload: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const socket = netConnect(port, "127.0.0.1", () => {
				socket.write(payload);
			});
			let response = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				response += chunk;
				if (response.includes("\r\n\r\n")) {
					socket.destroy();
					resolve(response);
				}
			});
			socket.on("end", () => resolve(response));
			socket.on("error", reject);
		});
	}

	it("blocks non-allowlisted HTTP and CONNECT requests with 403 and notifies", async () => {
		const blocked: BlockedEgressEvent[] = [];
		const proxy: EgressGuardProxy = await startEgressGuardProxy({
			allow: ["allowed.example.com"],
			mode: "block",
			onBlocked: (event) => blocked.push(event),
		});
		closers.push(() => proxy.close());

		const httpRes = await sendRaw(
			proxy.port,
			"GET http://api.mailjet.com/v3/send HTTP/1.1\r\nHost: api.mailjet.com\r\nConnection: close\r\n\r\n",
		);
		expect(httpRes).toContain("403 Forbidden");
		expect(httpRes).toContain("x-buncargo-egress-blocked: 1");

		const connectRes = await sendRaw(
			proxy.port,
			"CONNECT api.stripe.com:443 HTTP/1.1\r\nHost: api.stripe.com:443\r\n\r\n",
		);
		expect(connectRes).toContain("403 Forbidden");
		expect(connectRes).toContain("X-Buncargo-Egress-Blocked: 1");

		expect(blocked).toEqual([
			{ method: "GET", host: "api.mailjet.com", port: 80, mode: "block" },
			{ method: "CONNECT", host: "api.stripe.com", port: 443, mode: "block" },
		]);
	});

	it("lets a host learned with allowHosts through, and still blocks the rest", async () => {
		const blocked: BlockedEgressEvent[] = [];
		const proxy = await startEgressGuardProxy({
			allow: [],
			mode: "block",
			onBlocked: (event) => blocked.push(event),
		});
		closers.push(() => proxy.close());
		// `.invalid` never resolves (RFC 6761): let through, the dial fails with a 502.
		const connect = (host: string) =>
			sendRaw(
				proxy.port,
				`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`,
			);

		expect(await connect("unleash.invalid")).toContain("403 Forbidden");
		proxy.allowHosts(["unleash.invalid"]);

		expect(await connect("unleash.invalid")).toContain("502 Bad Gateway");
		expect(await connect("other.invalid")).toContain("403 Forbidden");
		// A learned host is an exact name, never a pattern.
		proxy.allowHosts(["*.invalid"]);
		expect(await connect("third.invalid")).toContain("403 Forbidden");
		expect(blocked.map((event) => event.host)).toEqual([
			"unleash.invalid",
			"other.invalid",
			"third.invalid",
		]);
	});

	it("rejects missing Host headers and self-proxy loops with 400", async () => {
		const proxy = await startEgressGuardProxy({ allow: [], mode: "block" });
		closers.push(() => proxy.close());

		const missingHost = await sendRaw(
			proxy.port,
			"GET /relative HTTP/1.0\r\n\r\n",
		);
		expect(missingHost).toContain("400 Bad Request");

		const selfHttp = await sendRaw(
			proxy.port,
			`GET http://127.0.0.1:${proxy.port}/ HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nConnection: close\r\n\r\n`,
		);
		expect(selfHttp).toContain("400 Bad Request");

		const selfConnect = await sendRaw(
			proxy.port,
			`CONNECT 127.0.0.1:${proxy.port} HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\n\r\n`,
		);
		expect(selfConnect).toContain("400 Bad Request");
	});

	it("tunnels loopback CONNECT targets cleanly", async () => {
		const echo = createNetServer((socket) => {
			socket.write("pong");
			socket.end();
		});
		await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
		const echoAddr = echo.address();
		if (!echoAddr || typeof echoAddr === "string") {
			throw new Error("Expected numeric echo address");
		}
		closers.push(
			() => new Promise<void>((resolve) => echo.close(() => resolve())),
		);

		const proxy = await startEgressGuardProxy({
			allow: [],
			mode: "block",
		});
		closers.push(() => proxy.close());

		const result = await new Promise<string>((resolve, reject) => {
			const socket = netConnect(proxy.port, "127.0.0.1", () => {
				socket.write(
					`CONNECT 127.0.0.1:${echoAddr.port} HTTP/1.1\r\nHost: 127.0.0.1:${echoAddr.port}\r\n\r\n`,
				);
			});
			let data = "";
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => {
				data += chunk;
			});
			socket.on("end", () => resolve(data));
			socket.on("error", reject);
		});
		expect(result).toContain("200 Connection Established");
		expect(result).toContain("pong");
	});

	it("starts and injects proxy env for covered apps during env.start() and closes on stop()", async () => {
		const [apiPort, workerPort] = freePorts(2);
		const env = createDevEnvironment(
			{
				projectPrefix: "egress-env",
				services: {},
				egressGuard: {
					allow: ["app.unleash-hosted.com"],
					apps: ["api"],
				},
				apps: {
					api: {
						port: apiPort,
						devCommand: `${JSON.stringify(process.execPath)} -e 'Bun.serve({ port: Number(process.env.PORT), fetch: () => Response.json({ proxy: process.env.HTTP_PROXY ?? null, nodeProxy: process.env.NODE_USE_ENV_PROXY ?? null, noProxy: process.env.NO_PROXY ?? null }) });'`,
						healthEndpoint: "/",
					},
					other: {
						port: workerPort,
						devCommand: `${JSON.stringify(process.execPath)} -e 'Bun.serve({ port: Number(process.env.PORT), fetch: () => Response.json({ proxy: process.env.HTTP_PROXY ?? null }) });'`,
						healthEndpoint: "/",
					},
				},
			},
			{ root: home() },
		);

		await env.start({ watchdog: false, verbose: false });
		closers.push(() => env.stop({ verbose: false }));

		const apiRes = (await (await fetch(env.loopbackUrls.api)).json()) as {
			proxy: string | null;
			nodeProxy: string | null;
			noProxy: string | null;
		};
		expect(apiRes.proxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(apiRes.nodeProxy).toBe("1");
		expect(apiRes.noProxy).toContain(".localhost");

		const otherRes = (await (await fetch(env.loopbackUrls.other)).json()) as {
			proxy: string | null;
		};
		expect(otherRes.proxy).toBeNull();
	});

	it("lets a guarded app through to the host of a URL its secret holds, and no other", async () => {
		const infisical = startFakeInfisical();
		infisical.projects.backend = {
			secrets: { UNLEASH_SERVER_API_URL: "https://unleash.invalid/api" },
		};
		const savedPath = process.env.BUNCARGO_INFISICAL_PATH;
		process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
		closers.push(async () => {
			infisical.stop();
			clearScopeSecretsCache();
			if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
			else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
		});

		const [adminPort] = freePorts(1);
		const env = createDevEnvironment(
			{
				projectPrefix: "egress-hosts",
				services: {},
				egressGuard: { allowHostsOf: ["UNLEASH_SERVER_API_URL"] },
				apps: {
					admin: {
						port: adminPort,
						devCommand: `${JSON.stringify(process.execPath)} -e 'Bun.serve({ port: Number(process.env.PORT), fetch: () => Response.json({ proxy: process.env.HTTPS_PROXY ?? null }) });'`,
						healthEndpoint: "/",
						secrets: { projectId: "backend", siteUrl: infisical.siteUrl },
					},
				},
			},
			{ root: home() },
		);

		await env.start({ watchdog: false, verbose: false });
		closers.push(() => env.stop({ verbose: false }));

		const { proxy } = (await (await fetch(env.loopbackUrls.admin)).json()) as {
			proxy: string;
		};
		const proxyPort = Number(new URL(proxy).port);
		const connect = (host: string) =>
			sendRaw(
				proxyPort,
				`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`,
			);

		expect(await connect("unleash.invalid")).toContain("502 Bad Gateway");
		expect(await connect("other.invalid")).toContain("403 Forbidden");
	});
});
