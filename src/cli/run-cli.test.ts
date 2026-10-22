import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, releaseLeases } from "../core/leases";
import { buildRunEntry, publishRun, retireRuns } from "../core/run-registry";
import { resolveExposeTargets, stopPublicTunnels } from "../core/tunnel";
import * as watchdog from "../core/watchdog";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { runCli } from "./run-cli";
import { upsertTunnelRegistryEntries } from "./tunnel-registry";

// ═══════════════════════════════════════════════════════════════════════════
// runCli + expose (stub env, mocked tunnel)
// ═══════════════════════════════════════════════════════════════════════════

// `runCli` publishes every run into `~/.buncargo/runs.json`. Point HOME at a
// temp dir so tests never write the developer's real registry, and restore it
// afterwards: the whole suite shares one process.
let stateHome: string;
const realHome = process.env.HOME;

beforeAll(() => {
	stateHome = mkdtempSync(join(tmpdir(), "buncargo-cli-state-"));
	process.env.HOME = stateHome;
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(stateHome, { recursive: true, force: true });
});

class ProcessExit extends Error {
	constructor(readonly exitCode: number) {
		super("PROCESS_EXIT");
	}
}

async function withProcessExitTrap(fn: () => Promise<void>): Promise<number> {
	const orig = process.exit;
	process.exit = ((code?: number) => {
		throw new ProcessExit(code ?? 0);
	}) as typeof process.exit;
	try {
		await fn();
		throw new Error("expected process.exit");
	} catch (e) {
		if (e instanceof ProcessExit) {
			return e.exitCode;
		}
		throw e;
	} finally {
		process.exit = orig;
	}
}

function createStubEnv(
	options: {
		apps?: Record<string, AppConfig>;
		services?: Record<string, ServiceConfig>;
		ports?: Record<string, number>;
		root?: string;
		start?: (options?: unknown) => Promise<null>;
		waitForServer?: (url: string, timeout?: number) => Promise<void>;
		waitForServers?: (options?: { onlyApps?: string[] }) => void;
		setPublicUrls?: (urls: Record<string, string>) => void;
	} = {},
): DevEnvironment<Record<string, ServiceConfig>, Record<string, AppConfig>> {
	const apps = options.apps ?? {
		api: {
			port: 3000,
			devCommand: "bun run dev",
			expose: true,
		},
	};
	const services = options.services ?? {
		postgres: { port: 5432, healthCheck: false as const },
	};
	for (const app of Object.values(apps)) {
		app.requiredServices ??= Object.keys(services);
	}
	const ports =
		options.ports ??
		Object.fromEntries(
			Object.entries(apps).map(([name, config]) => [name, config.port]),
		);
	const publicUrls: Record<string, string> = {};
	return {
		services,
		apps,
		ports: ports as DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>["ports"],
		urls: Object.fromEntries(
			Object.entries(ports).map(([name, port]) => [
				name,
				`http://localhost:${port}`,
			]),
		) as DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>["urls"],
		publicUrls: {},
		loopbackUrls: Object.fromEntries(
			Object.entries(ports).map(([name, port]) => [
				name,
				`http://localhost:${port}`,
			]),
		) as DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>["loopbackUrls"],
		projectName: "stub-cli",
		projectPrefix: "stub",
		workspaceId: "0123456789abcdef",
		prepareStart: () => {},
		prepareStartAsync: async () => {},
		resolvePrimaryApp: (selected?: readonly string[]) =>
			(selected ?? Object.keys(apps))[0],
		root: options.root ?? "/tmp/buncargo-cli-stub",
		composeFile: ".buncargo/docker-compose.generated.yml",
		containerRuntime: "docker",
		portOffset: 0,
		portOffsetProvenance: "hash",
		isWorktree: false,
		localIp: "127.0.0.1",
		start: async (startOptions?: unknown) => {
			if (options.start) {
				return options.start(startOptions);
			}
			return null;
		},
		stop: async () => {},
		restart: async () => {},
		isRunning: async () => true,
		startServers: async () => ({}),
		stopProcess: () => {},
		waitForServers: async (waitOptions?: { onlyApps?: string[] }) => {
			options.waitForServers?.(waitOptions);
		},
		buildEnvVars: () => ({}),
		buildAppEnvVars: () => {
			const vars: Record<string, string> = {};
			for (const [name, url] of Object.entries(publicUrls)) {
				vars[`${name.toUpperCase()}_PUBLIC_URL`] = url;
			}
			return vars;
		},
		setPublicUrls: (urls: Record<string, string>) => {
			Object.assign(publicUrls, urls);
			options.setPublicUrls?.(urls as Record<string, string>);
		},
		clearPublicUrls: () => {},
		ensureComposeFile: () => ".buncargo/docker-compose.generated.yml",
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		waitForServer: async (url: string, timeout?: number) => {
			await options.waitForServer?.(url, timeout);
		},
		logInfo: () => {},
		captured: {},
		recordCapture: async () => [],
		renderGeneratedFiles: () => [],
		details: () => ({}),
		getExpoApiUrl: () => "http://127.0.0.1:3000",
		getFrontendPort: () => 5173,
		sessionId: "test-session",
		claimRun: async () => {},
		releaseRun: async () => {},
		reportServiceChanges: () => {},
		ensureWatchdog: async () => {},
		withSuffix: () =>
			createStubEnv() as DevEnvironment<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>,
		openPublicTunnels: async () => {
			throw new Error("not used");
		},
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
}

async function listenServer(port: number): Promise<Server> {
	const server = createServer((_req, res) => {
		res.statusCode = 200;
		res.end("ok");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	return server;
}

describe("runCli expose routing", () => {
	it("does not call startPublicTunnels when --expose is absent", async () => {
		let startCalls = 0;
		const code = await withProcessExitTrap(() =>
			runCli(createStubEnv(), {
				args: ["--migrate"],
				watchdog: false,
				cliTestTunnel: {
					resolveExposeTargets,
					startPublicTunnels: async (_targets) => {
						startCalls += 1;
						return [];
					},
					stopPublicTunnels,
				},
			}),
		);
		expect(code).toBe(0);
		expect(startCalls).toBe(0);
	});

	it("calls startPublicTunnels when --expose is set", async () => {
		let startCalls = 0;
		const code = await withProcessExitTrap(() =>
			runCli(createStubEnv(), {
				args: ["--migrate", "--expose"],
				watchdog: false,
				cliTestTunnel: {
					resolveExposeTargets,
					startPublicTunnels: async (targets) => {
						startCalls += 1;
						expect(targets.length).toBeGreaterThan(0);
						return targets.map((t) => ({
							kind: t.kind,
							name: t.name,
							localUrl: `http://localhost:${t.port}`,
							publicUrl: "https://mock.example.com",
							close: async () => {},
						}));
					},
					stopPublicTunnels,
				},
			}),
		);
		expect(code).toBe(0);
		expect(startCalls).toBe(1);
	});

	it("accepts --apps during migrate flow", async () => {
		const code = await withProcessExitTrap(() =>
			runCli(createStubEnv(), {
				args: ["--migrate", "--apps=api"],
				watchdog: false,
			}),
		);
		expect(code).toBe(0);
	});

	it("passes direct --apps selection into env.start", async () => {
		const startCalls: unknown[] = [];
		const code = await withProcessExitTrap(() =>
			runCli(
				createStubEnv({
					apps: {
						api: {
							port: 3000,
							devCommand: "bun run api",
							requiredServices: ["postgres"],
						},
						expo: {
							port: 8081,
							devCommand: "bun run expo",
							requiredApps: ["api"],
							requiredServices: ["postgres"],
						},
					},
					services: {
						postgres: { port: 5432 },
					},
					start: async (startOptions) => {
						startCalls.push(startOptions);
						return null;
					},
				}),
				{
					args: ["--migrate", "--apps=expo"],
					watchdog: false,
				},
			),
		);

		expect(code).toBe(0);
		expect(startCalls).toMatchObject([
			{
				startServers: false,
				wait: true,
				skipSeed: true,
				prepare: "migrate",
				skipEnvironmentLog: true,
				onlyApps: ["expo"],
				autoStartDocker: undefined,
				// Development in CI too, like the dev servers it goes on to run.
				productionBuild: false,
			},
		]);
	});

	it("prefetches the seed's secrets for --seed while the containers start", async () => {
		const startCalls: unknown[] = [];
		const env = createStubEnv({
			start: async (startOptions) => {
				startCalls.push(startOptions);
				return null;
			},
		});
		(env as { runSeed: unknown }).runSeed = async () => ({
			status: "succeeded",
			result: { exitCode: 0, stdout: "", stderr: "" },
		});
		const code = await withProcessExitTrap(() =>
			runCli(env, { args: ["--seed"], watchdog: false }),
		);

		expect(code).toBe(0);
		expect(startCalls).toMatchObject([
			{ skipSeed: true, prefetchSeed: true, prepare: "all" },
		]);
	});

	it("rejects unknown app names from --apps", async () => {
		const code = await withProcessExitTrap(() =>
			runCli(createStubEnv(), {
				args: ["--migrate", "--apps=missing"],
				watchdog: false,
			}),
		);
		expect(code).toBe(1);
	});

	it("rejects empty --apps value", async () => {
		const code = await withProcessExitTrap(() =>
			runCli(createStubEnv(), {
				args: ["--migrate", "--apps="],
				watchdog: false,
			}),
		);
		expect(code).toBe(1);
	});

	it("errors when --expose selects an app outside --apps", async () => {
		const env = createStubEnv({
			apps: {
				api: { port: 43010, devCommand: "bun run api", expose: true },
				web: { port: 43011, devCommand: "bun run web", expose: true },
			},
		});
		const code = await withProcessExitTrap(() =>
			runCli(env, {
				args: ["--migrate", "--apps=api", "--expose=web"],
				watchdog: false,
				cliTestTunnel: {
					resolveExposeTargets,
					startPublicTunnels: async () => [],
					stopPublicTunnels,
				},
			}),
		);
		expect(code).toBe(1);
	});

	it("allows --expose to target apps included via requiredApps", async () => {
		const env = createStubEnv({
			services: {
				postgres: { port: 5432 },
			},
			apps: {
				api: {
					port: 43010,
					devCommand: "bun run api",
					expose: true,
					requiredServices: ["postgres"],
				},
				expo: {
					port: 43011,
					devCommand: "bun run expo",
					expose: true,
					requiredApps: ["api"],
					requiredServices: ["postgres"],
				},
			},
		});
		const code = await withProcessExitTrap(() =>
			runCli(env, {
				args: ["--migrate", "--apps=expo", "--expose=api"],
				watchdog: false,
				cliTestTunnel: {
					resolveExposeTargets,
					startPublicTunnels: async () => [],
					stopPublicTunnels,
				},
			}),
		);

		expect(code).toBe(0);
	});

	it("reuses a busy exposed app and inherits its public URL", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-cli-"));
		const apiPort = 43020;
		const webPort = 43021;
		const server = await listenServer(apiPort);
		const setPublicUrlsCalls: Record<string, string>[] = [];
		const startTargets: string[][] = [];

		try {
			await upsertTunnelRegistryEntries(root, [
				{
					kind: "app",
					name: "api",
					publicUrl: "https://api.example.com",
					localUrl: `http://localhost:${apiPort}`,
					port: apiPort,
					pid: process.pid,
					updatedAt: new Date().toISOString(),
				},
			]);

			const env = createStubEnv({
				root,
				apps: {
					api: {
						port: apiPort,
						devCommand: "bun run api",
						expose: true,
						healthEndpoint: "/",
					},
					web: {
						port: webPort,
						devCommand: "bun run web",
						expose: true,
					},
				},
				ports: { api: apiPort, web: webPort },
				waitForServer: async (url) => {
					expect(url).toBe(`http://localhost:${apiPort}/`);
				},
				setPublicUrls: (urls) => {
					setPublicUrlsCalls.push({ ...urls });
				},
			});

			const code = await withProcessExitTrap(() =>
				runCli(env, {
					args: ["--migrate", "--apps=api,web", "--expose"],
					watchdog: false,
					cliTestTunnel: {
						resolveExposeTargets,
						startPublicTunnels: async (targets) => {
							startTargets.push(targets.map((target) => target.name));
							return targets.map((target) => ({
								kind: target.kind,
								name: target.name,
								localUrl: `http://localhost:${target.port}`,
								publicUrl: `https://${target.name}.example.com`,
								close: async () => {},
							}));
						},
						stopPublicTunnels,
					},
				}),
			);

			expect(code).toBe(0);
			expect(startTargets).toEqual([["web"]]);
			expect(setPublicUrlsCalls.at(-1)).toEqual({
				api: "https://api.example.com",
				web: "https://web.example.com",
			});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("runCli phased tunnels and attach", () => {
	it("starts needsPublicUrls apps after tunnels and injects *_PUBLIC_URL", async () => {
		const apiPort = 43210 + Math.floor(Math.random() * 200);
		const expoPort = apiPort + 1;
		const tunnelOrder: string[] = [];
		const env = createStubEnv({
			apps: {
				api: {
					port: apiPort,
					devCommand: "bun -e 'setInterval(() => {}, 1000)'",
					healthEndpoint: false,
					expose: true,
				},
				expoApp: {
					port: expoPort,
					devCommand:
						"bun -e 'if (!process.env.API_PUBLIC_URL) process.exit(2); process.exit(0)'",
					healthEndpoint: false,
					interactive: true,
					needsPublicUrls: true,
					requiredApps: ["api"],
				},
			},
		});

		await runCli(env, {
			args: ["--apps=expoApp", "--expose"],
			watchdog: false,
			cliTestTunnel: {
				resolveExposeTargets,
				startPublicTunnels: async (targets) => {
					tunnelOrder.push("tunnels");
					return targets.map((target) => ({
						kind: target.kind,
						name: target.name,
						localUrl: `http://localhost:${target.port}`,
						publicUrl: `https://${target.name}.example.com`,
						close: async () => {},
					}));
				},
				stopPublicTunnels,
			},
		});

		expect(tunnelOrder).toEqual(["tunnels"]);
	});

	// Without --expose there is no tunnel to wait for, so holding the app back
	// only robs it of its health check. A repo should not have to sniff argv to
	// get this right from one static config.
	it("health-checks needsPublicUrls apps when --expose is absent", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-waves-"));
		const apiPort = 43610 + Math.floor(Math.random() * 200);
		const expoPort = apiPort + 1;
		const healthChecked: string[][] = [];
		const env = createStubEnv({
			root,
			apps: {
				api: {
					port: apiPort,
					devCommand: "bun -e 'process.exit(0)'",
					healthEndpoint: false,
				},
				expoApp: {
					port: expoPort,
					devCommand: "bun -e 'process.exit(0)'",
					healthEndpoint: false,
					needsPublicUrls: true,
				},
			},
			waitForServers: (waitOptions) => {
				healthChecked.push([...(waitOptions?.onlyApps ?? [])].sort());
			},
		});

		try {
			await runCli(env, { args: [], watchdog: false });
			expect(healthChecked).toEqual([["api", "expoApp"]]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("gives apps the library's readiness timeout, longer in CI", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-ready-timeout-"));
		const port = 43810 + Math.floor(Math.random() * 200);
		const timeouts: unknown[] = [];
		const env = createStubEnv({
			root,
			apps: {
				api: {
					port,
					devCommand: "bun -e 'process.exit(0)'",
					healthEndpoint: false,
				},
			},
			waitForServers: (waitOptions) => {
				timeouts.push((waitOptions as { timeout?: number }).timeout);
			},
		});
		const ci = process.env.CI;
		process.env.CI = "true";

		try {
			await runCli(env, { args: [], watchdog: false });
			expect(timeouts).toEqual([120_000]);
		} finally {
			if (ci === undefined) delete process.env.CI;
			else process.env.CI = ci;
			await rm(root, { recursive: true, force: true });
		}
	});

	// The watchdog is what lists live runs to BuncargoBar on the tailnet, and
	// `start()` only ensures it for a run with containers.
	it("ensures the watchdog for an app-only run once its apps are up", async () => {
		const root = await mkdtemp(join(tmpdir(), "buncargo-app-only-"));
		const port = 44010 + Math.floor(Math.random() * 200);
		const order: string[] = [];
		const ensure = spyOn(watchdog, "ensureWatchdog").mockImplementation(
			async () => {
				order.push("watchdog");
			},
		);
		const env = createStubEnv({
			root,
			apps: {
				api: {
					port,
					devCommand: "bun -e 'process.exit(0)'",
					healthEndpoint: false,
					requiredServices: [],
				},
			},
			waitForServers: () => {
				order.push("ready");
			},
		});

		try {
			await runCli(env, { args: [] });
			expect(order).toEqual(["ready", "watchdog"]);
			expect(ensure).toHaveBeenCalledWith({ verbose: false });
		} finally {
			ensure.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("kills sibling apps when the attached app exits", async () => {
		const apiPort = 43410 + Math.floor(Math.random() * 200);
		const expoPort = apiPort + 1;
		const env = createStubEnv({
			apps: {
				api: {
					port: apiPort,
					devCommand: "bun -e 'setInterval(() => {}, 1000)'",
					healthEndpoint: false,
				},
				expoApp: {
					port: expoPort,
					devCommand: "bun -e 'process.exit(0)'",
					healthEndpoint: false,
					interactive: true,
				},
			},
		});

		await runCli(env, {
			args: ["--apps=api,expoApp", "--attach=expoApp"],
			watchdog: false,
		});
	});
});

it("takes over a reused API while also starting a new web app", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-mixed-takeover-"));
	const child = spawn(
		process.execPath,
		[
			"-e",
			'const s = Bun.serve({port: 0, fetch: () => new Response("old")}); console.log(s.port)',
		],
		{ cwd: root, detached: true, stdio: ["ignore", "pipe", "ignore"] },
	);
	try {
		const apiPort = await new Promise<number>((resolve, reject) => {
			child.stdout.once("data", (data) => resolve(Number(String(data).trim())));
			child.once("error", reject);
		});
		const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
		const webPort = probe.port as number;
		probe.stop(true);
		const command = (name: string) =>
			`bun -e 'await Bun.write("${name}-started", "yes")'`;
		const env = createStubEnv({
			root,
			apps: {
				api: {
					port: apiPort,
					devCommand: command("api"),
					healthEndpoint: false,
				},
				web: {
					port: webPort,
					devCommand: command("web"),
					healthEndpoint: false,
				},
			},
		});
		await runCli(env, {
			args: ["--takeover", "--no-hosts"],
			watchdog: false,
		});
		expect(await Bun.file(join(root, "api-started")).text()).toBe("yes");
		expect(await Bun.file(join(root, "web-started")).text()).toBe("yes");
	} finally {
		if (child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* Already stopped by takeover. */
			}
		}
		await rm(root, { recursive: true, force: true });
	}
});

describe("an app port held by a server failing its health check", () => {
	async function replaceUnhealthyApi(
		holder: (root: string, pid: number, port: number) => Promise<void>,
	): Promise<string> {
		// Real path: the cwd lsof reports for the server is resolved.
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "buncargo-unhealthy-")),
		);
		const child = spawn(
			process.execPath,
			[
				"-e",
				'const s = Bun.serve({port: 0, fetch: () => new Response("broken", {status: 500})}); console.log(s.port)',
			],
			{ cwd: root, detached: true, stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			const apiPort = await new Promise<number>((resolve, reject) => {
				child.stdout.once("data", (data) =>
					resolve(Number(String(data).trim())),
				);
				child.once("error", reject);
			});
			await holder(root, child.pid as number, apiPort);
			let probes = 0;
			const env = createStubEnv({
				root,
				apps: {
					api: {
						port: apiPort,
						devCommand: `bun -e 'await Bun.write("api-started", "yes")'`,
						healthEndpoint: "/",
					},
				},
				waitForServer: async () => {
					probes++;
					if (probes === 1) throw new Error("500");
				},
			});
			const stdinTTY = process.stdin.isTTY;
			process.stdin.isTTY = false;
			const said: string[] = [];
			const realLog = console.log;
			console.log = (...parts: unknown[]) => said.push(parts.join(" "));
			try {
				// The stub app exits before it answers, which ends the run: only
				// that it was spawned matters here.
				await withProcessExitTrap(() =>
					runCli(env, { args: ["--no-hosts"], watchdog: false }),
				);
			} finally {
				console.log = realLog;
				process.stdin.isTTY = stdinTTY;
			}

			expect(await Bun.file(join(root, "api-started")).text()).toBe("yes");
			return said.join("\n");
		} finally {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					/* Already stopped by this run. */
				}
			}
			await retireRuns(["unhealthy-sibling"]);
			await rm(root, { recursive: true, force: true });
		}
	}

	it("stops a leftover no run owns and starts the app", async () => {
		const said = await replaceUnhealthyApi(async () => {});
		expect(said).toContain('Stopped a leftover "api"');
	});

	it("takes over a detached sibling run's app without asking", async () => {
		const said = await replaceUnhealthyApi(async (root, pid, port) => {
			await publishRun({
				...buildRunEntry({
					sessionId: "unhealthy-sibling",
					projectPrefix: "stub",
					projectName: "stub-cli",
					root,
					isWorktree: false,
				}),
				detached: true,
				apps: [
					{
						name: "api",
						pid,
						port,
						url: `http://localhost:${port}`,
						loopbackUrl: `http://localhost:${port}`,
						status: "ready",
					},
				],
			});
		});
		expect(said).not.toContain("leftover");
		expect(said).toContain("Stopped:");
	});
});

it("starts the rest of the run without an optional app whose lease another run holds", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-lease-skip-"));
	try {
		// Another checkout's run, alive (this process), holds the lease.
		await acquireLease({
			key: "shopify-app:skip-test",
			sessionId: "other-run",
			app: "shopify",
			projectName: "stub-cli",
			root: "/elsewhere/checkout",
			worktree: "checkout",
		});
		const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
		const apiPort = probe.port as number;
		probe.stop(true);
		const command = (name: string) =>
			`bun -e 'await Bun.write("${name}-started", "yes")'`;
		const env = createStubEnv({
			root,
			apps: {
				api: {
					port: apiPort,
					devCommand: command("api"),
					healthEndpoint: false,
				},
				shopify: {
					kind: "worker",
					devCommand: command("shopify"),
					essential: false,
					exclusive: "shopify-app:skip-test",
				},
			},
		});
		// Without a terminal, whatever runs the tests: a prompt would wait forever.
		const stdinTTY = process.stdin.isTTY;
		process.stdin.isTTY = false;
		const warnings: string[] = [];
		const realWarn = console.warn;
		const realError = console.error;
		console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
		console.error = (...parts: unknown[]) => warnings.push(parts.join(" "));
		try {
			await runCli(env, { args: ["--no-hosts"], watchdog: false });
		} finally {
			console.warn = realWarn;
			console.error = realError;
			process.stdin.isTTY = stdinTTY;
		}

		expect(await Bun.file(join(root, "api-started")).text()).toBe("yes");
		expect(await Bun.file(join(root, "shopify-started")).exists()).toBe(false);
		const said = warnings.join("\n");
		expect(said).toContain(
			"Not starting shopify: shopify-app:skip-test is held by another run.",
		);
		expect(said).toContain("Checkout: /elsewhere/checkout");
		expect(said).toContain("buncargo dev --takeover");
	} finally {
		await releaseLeases("other-run");
		await rm(root, { recursive: true, force: true });
	}
});

// A config with services and no apps used to print "Nothing to start" and
// release the containers it had just brought up.
it("holds a services-only run until it is told to stop", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-services-only-"));
	let released = 0;
	const env = createStubEnv({ apps: {}, root });
	Object.assign(env, {
		releaseRun: async () => {
			released++;
		},
	});
	const printed: string[] = [];
	const realLog = console.log;
	console.log = (...parts: unknown[]) => printed.push(parts.join(" "));
	const said = (text: string) => printed.some((line) => line.includes(text));
	const run = runCli(env, { args: ["--no-hosts"], watchdog: false });
	try {
		const deadline = performance.now() + 5_000;
		while (!said("Services ready") && !said("Nothing to start")) {
			if (performance.now() > deadline) throw new Error("The run never said");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(said("Nothing to start")).toBe(false);
		expect(released).toBe(0);

		process.emit("SIGINT");
		await run;
		expect(released).toBe(1);
	} finally {
		console.log = realLog;
		if (released === 0) process.emit("SIGTERM");
		await run;
		await rm(root, { recursive: true, force: true });
	}
});
