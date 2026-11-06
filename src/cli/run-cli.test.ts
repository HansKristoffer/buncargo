import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLease, releaseLeases } from "../core/leases";
import {
	buildRunEntry,
	findRunsByRoot,
	publishRun,
	retireRuns,
} from "../core/run-registry";
import { resolveExposeTargets, stopPublicTunnels } from "../core/tunnel";
import * as watchdog from "../core/watchdog";
import { SeedFailedError } from "../environment/seed-startup";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { type DetachedReport, readDetachedReport } from "./dev-detach";
import { requestRestart } from "./restart-requests";
import { runCli } from "./run-cli";
import * as takeover from "./takeover";
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
		publicUrls,
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
		// Replaces the map in place, as the environment's does.
		setPublicUrls: (urls: Record<string, string>) => {
			for (const key of Object.keys(publicUrls)) delete publicUrls[key];
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

/**
 * Ends the run with a Ctrl-C once its tunnels have opened and it has printed
 * their URLs: what is left to check about `--expose` has happened by then.
 */
function endsOnceTunnelsOpen<T extends { logInfo: unknown }>(env: T): T {
	return Object.assign(env, {
		logInfo: (title?: string) => {
			if (title === "Dev Environment") process.emit("SIGINT");
		},
	});
}

function mockTunnels(
	targets: readonly { kind: "app" | "service"; name: string; port: number }[],
) {
	return targets.map((target) => ({
		kind: target.kind,
		name: target.name,
		localUrl: `http://localhost:${target.port}`,
		publicUrl: `https://${target.name}.example.com`,
		close: async () => {},
	}));
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

	// The tunnel closed as the command exited, so the URL it printed was dead.
	it("ignores --expose and --takeover in a one-shot mode, saying why", async () => {
		let startCalls = 0;
		const warned: string[] = [];
		const realWarn = console.warn;
		console.warn = (...parts: unknown[]) => warned.push(parts.join(" "));
		try {
			const code = await withProcessExitTrap(() =>
				runCli(createStubEnv(), {
					args: ["--up-only", "--expose", "--takeover"],
					watchdog: false,
					cliTestTunnel: {
						resolveExposeTargets,
						startPublicTunnels: async () => {
							startCalls += 1;
							return [];
						},
						stopPublicTunnels,
					},
				}),
			);
			expect(code).toBe(0);
		} finally {
			console.warn = realWarn;
		}
		expect(startCalls).toBe(0);
		const said = Bun.stripANSI(warned.join("\n"));
		expect(said).toContain("--expose is ignored with --up-only");
		expect(said).toContain("buncargo dev --detach --expose");
		expect(said).toContain("--takeover is ignored with --up-only");
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
				args: ["--no-hosts", "--apps=api", "--expose=web"],
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
		const port = 43810 + Math.floor(Math.random() * 100) * 2;
		const env = endsOnceTunnelsOpen(
			createStubEnv({
				services: {
					postgres: { port: 5432 },
				},
				apps: {
					api: {
						port,
						devCommand: "bun -e 'setInterval(() => {}, 1000)'",
						healthEndpoint: false,
						expose: true,
						requiredServices: ["postgres"],
					},
					expo: {
						port: port + 1,
						devCommand: "bun -e 'setInterval(() => {}, 1000)'",
						healthEndpoint: false,
						expose: true,
						requiredApps: ["api"],
						requiredServices: ["postgres"],
					},
				},
			}),
		);
		const opened: string[][] = [];
		const code = await withProcessExitTrap(() =>
			runCli(env, {
				args: ["--no-hosts", "--no-tui", "--apps=expo", "--expose=api"],
				watchdog: false,
				cliTestTunnel: {
					resolveExposeTargets,
					startPublicTunnels: async (targets) => {
						opened.push(targets.map((target) => target.name));
						return mockTunnels(targets);
					},
					stopPublicTunnels,
				},
			}),
		);

		expect(code).toBe(130);
		expect(opened).toEqual([["api"]]);
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

			const env = endsOnceTunnelsOpen(
				createStubEnv({
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
							devCommand: "bun -e 'setInterval(() => {}, 1000)'",
							healthEndpoint: false,
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
				}),
			);

			const code = await withProcessExitTrap(() =>
				runCli(env, {
					args: ["--no-hosts", "--no-tui", "--apps=api,web", "--expose"],
					watchdog: false,
					cliTestTunnel: {
						resolveExposeTargets,
						startPublicTunnels: async (targets) => {
							startTargets.push(targets.map((target) => target.name));
							return mockTunnels(targets);
						},
						stopPublicTunnels,
					},
				}),
			);

			expect(code).toBe(130);
			expect(startTargets).toEqual([["web"]]);
			// Opened beside the inherited one; closing removed both.
			expect(setPublicUrlsCalls.at(-2)).toEqual({
				api: "https://api.example.com",
				web: "https://web.example.com",
			});
			expect(setPublicUrlsCalls.at(-1)).toEqual({});
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
});

// Every exposed app reused, its public URL the other run's tunnel: a `y` used
// to stop that run, tunnels and all, and leave this one advertising its URL.
it("does not offer to take over a run whose tunnels it inherited", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-inherit-takeover-"));
	const apiPort = 43030 + Math.floor(Math.random() * 200);
	const server = await listenServer(apiPort);
	const prompt = spyOn(takeover, "promptTakeover").mockImplementation(
		async () => false,
	);
	const tty = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
	const ci = process.env.CI;
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
			services: {},
			apps: {
				api: {
					port: apiPort,
					devCommand: "bun run api",
					expose: true,
					healthEndpoint: "/",
					requiredServices: [],
				},
			},
			ports: { api: apiPort },
		});
		process.stdin.isTTY = true;
		process.stdout.isTTY = true;
		// No menu bar offer in the way of the question under test.
		process.env.CI = "1";
		await runCli(env, {
			args: ["--expose", "--no-hosts"],
			watchdog: false,
			cliTestTunnel: {
				resolveExposeTargets,
				startPublicTunnels: async () => [],
				stopPublicTunnels,
			},
		});
		expect(prompt).not.toHaveBeenCalled();
	} finally {
		process.stdin.isTTY = tty.stdin;
		process.stdout.isTTY = tty.stdout;
		if (ci === undefined) delete process.env.CI;
		else process.env.CI = ci;
		prompt.mockRestore();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(root, { recursive: true, force: true });
	}
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
	const run = withProcessExitTrap(() =>
		runCli(env, { args: ["--no-hosts"], watchdog: false }),
	);
	try {
		const deadline = performance.now() + 5_000;
		while (!said("Services ready") && !said("Nothing to start")) {
			if (performance.now() > deadline) throw new Error("The run never said");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(said("Nothing to start")).toBe(false);
		expect(released).toBe(0);

		process.emit("SIGINT");
		// Interrupted, like a run of apps: not a clean 0.
		expect(await run).toBe(130);
		expect(released).toBe(1);
	} finally {
		console.log = realLog;
		if (released === 0) process.emit("SIGTERM");
		await run.catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

// `buncargo wait` reads the registry: a restarted app's row has to go back
// to `starting`, or it answers from the process being replaced.
it("marks a restarted app starting in the registry until it is ready again", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "buncargo-restart-row-")),
	);
	const port = 44810 + Math.floor(Math.random() * 100);
	let healthChecks = 0;
	const env = createStubEnv({
		root,
		services: {},
		apps: {
			api: {
				port,
				devCommand: "bun -e 'setInterval(() => {}, 1000)'",
				healthEndpoint: false,
				requiredServices: [],
			},
		},
		// The restarted process never answers: its row stays `starting`.
		waitForServers: () => {
			healthChecks++;
			return healthChecks === 1 ? undefined : new Promise(() => {});
		},
	});
	const status = async () =>
		(await findRunsByRoot(root))
			.find((run) => run.sessionId === env.sessionId)
			?.apps.find((app) => app.name === "api")?.status;
	const until = async (want: string) => {
		const deadline = performance.now() + 4_000;
		while ((await status()) !== want) {
			if (performance.now() > deadline)
				throw new Error(`api never became ${want}`);
			await Bun.sleep(20);
		}
	};
	const run = withProcessExitTrap(() =>
		runCli(env, { args: ["--no-hosts", "--no-tui"], watchdog: false }),
	);
	try {
		await until("ready");
		requestRestart(root, env.sessionId, "api");
		await until("starting");
	} finally {
		process.emit("SIGINT");
		expect(await run).toBe(130);
		await rm(root, { recursive: true, force: true });
	}
});

it("records a parked app failed, and a recovered one's exit as an essential app's", async () => {
	// A parked app's stop reached the registry as `stopped`, which outranks
	// the `failed` reported after it. And once a restart brought it up, the
	// run still read it as parked: an essential worker that then exited 0
	// was recorded `stopped` too.
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "buncargo-recovered-row-")),
	);
	const marker = join(root, "ran-once");
	const go = join(root, "go");
	// Silent the first time, so it is parked; the second says it is ready,
	// then exits 0 once told to.
	const script = join(root, "jobs.ts");
	await Bun.write(
		script,
		`const marker = ${JSON.stringify(marker)};
if (!(await Bun.file(marker).exists())) await Bun.write(marker, "1");
else {
	console.log("jobs ready");
	setInterval(async () => {
		if (await Bun.file(${JSON.stringify(go)}).exists()) process.exit(0);
	}, 20);
}
setInterval(() => {}, 60_000);
`,
	);
	const env = createStubEnv({
		root,
		services: {},
		// Workers have none.
		ports: {},
		apps: {
			keeper: {
				kind: "worker",
				devCommand: "bun -e 'setInterval(() => {}, 60000)'",
				requiredServices: [],
			},
			jobs: {
				kind: "worker",
				devCommand: `bun ${script}`,
				readyWhen: /jobs ready/,
				healthTimeout: 500,
				requiredServices: [],
			},
		},
	});
	const status = async () =>
		(await findRunsByRoot(root))
			.find((run) => run.sessionId === env.sessionId)
			?.apps.find((app) => app.name === "jobs")?.status;
	const until = async (want: string) => {
		const deadline = performance.now() + 8_000;
		while ((await status()) !== want) {
			if (performance.now() > deadline)
				throw new Error(`jobs never became ${want}`);
			await Bun.sleep(20);
		}
	};
	let ended = false;
	const run = withProcessExitTrap(() =>
		runCli(env, { args: ["--no-hosts", "--no-tui"], watchdog: false }),
	).finally(() => {
		ended = true;
	});
	try {
		await until("failed");
		requestRestart(root, env.sessionId, "jobs");
		await until("ready");
		await Bun.write(go, "1");
		expect(await run).toBe(1);
		expect(await status()).toBe("failed");
	} finally {
		if (!ended) process.emit("SIGINT");
		await run.catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);

describe("how a run ends", () => {
	it("tears down once when an app fails during start", async () => {
		const port = 44610 + Math.floor(Math.random() * 200);
		let released = 0;
		const env = createStubEnv({
			services: {},
			apps: {
				api: {
					port,
					devCommand: "bun -e 'process.exit(1)'",
					healthEndpoint: false,
					requiredServices: [],
				},
			},
			waitForServers: () => new Promise(() => {}),
		});
		Object.assign(env, {
			releaseRun: async () => {
				released++;
			},
		});
		const code = await withProcessExitTrap(() =>
			runCli(env, { args: ["--no-hosts"], watchdog: false }),
		);
		expect(code).toBe(1);
		expect(released).toBe(1);
	});

	it("ends --down with the same teardown as every other run", async () => {
		let stopped = 0;
		let released = 0;
		const env = createStubEnv();
		Object.assign(env, {
			stop: async () => {
				stopped++;
			},
			releaseRun: async () => {
				released++;
			},
		});
		const code = await withProcessExitTrap(() =>
			runCli(env, { args: ["--down"], watchdog: false }),
		);
		expect(code).toBe(0);
		expect(stopped).toBe(1);
		expect(released).toBe(1);
	});

	// A second signal used to exit at once, closing the terminal of an app
	// still saving its data within its stopGraceMs. It names the app now.
	it("waits for an app still stopping on a second signal", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "buncargo-second-signal-")),
		);
		const port = 44910 + Math.floor(Math.random() * 100);
		const env = createStubEnv({
			root,
			services: {},
			apps: {
				api: {
					port,
					// Takes SIGTERM and keeps going, as an app saving data does.
					devCommand:
						"bun -e 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'",
					healthEndpoint: false,
					requiredServices: [],
					stopGraceMs: 1_000,
				},
			},
		});
		const status = async () =>
			(await findRunsByRoot(root))
				.find((run) => run.sessionId === env.sessionId)
				?.apps.find((app) => app.name === "api")?.status;
		const warn = spyOn(console, "warn");
		const run = withProcessExitTrap(() =>
			runCli(env, { args: ["--no-hosts", "--no-tui"], watchdog: false }),
		);
		try {
			const deadline = performance.now() + 4_000;
			while ((await status()) !== "ready") {
				if (performance.now() > deadline) throw new Error("api never ready");
				await Bun.sleep(20);
			}
			process.emit("SIGINT");
			// Another signal than the first, so no echo filter decides it.
			process.emit("SIGTERM");
			const warned = warn.mock.calls.map((call) => String(call[0]));
			expect(warned.some((line) => line.includes("Still stopping api"))).toBe(
				true,
			);
			// The app's grace ran out and the run ended with the first signal.
			expect(await run).toBe(130);
		} finally {
			warn.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	// A step that takes no signal finishes, and the run stops at the next
	// boundary instead of claiming containers and starting them.
	it("claims nothing once interrupted, and exits 130", async () => {
		let claims = 0;
		const env = createStubEnv();
		Object.assign(env, {
			prepareStartAsync: async () => {
				process.emit("SIGINT");
			},
			claimRun: async () => {
				claims++;
			},
		});
		const code = await withProcessExitTrap(() =>
			runCli(env, { args: ["--no-hosts", "--no-tui"], watchdog: false }),
		);
		expect(code).toBe(130);
		expect(claims).toBe(0);
	});
});

// `dev --detach` printed the exit code first and the cause somewhere above it:
// the background run now hands its parent the failure, named, with the
// failing step's last lines and the setup checks that warned.
describe("a failed detached run's report", () => {
	async function failedRun(
		options: Parameters<typeof createStubEnv>[0],
	): Promise<{ code: number; report: DetachedReport | undefined }> {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "buncargo-failure-")),
		);
		const saved = process.env.BUNCARGO_DETACHED;
		process.env.BUNCARGO_DETACHED = "1";
		try {
			const env = createStubEnv({ ...options, root });
			const code = await withProcessExitTrap(() =>
				runCli(env, { args: [], watchdog: false }),
			);
			return { code, report: readDetachedReport(root, process.pid) };
		} finally {
			if (saved === undefined) delete process.env.BUNCARGO_DETACHED;
			else process.env.BUNCARGO_DETACHED = saved;
			await rm(root, { recursive: true, force: true });
		}
	}

	it("names a failed seed and keeps its last lines", async () => {
		const { code, report } = await failedRun({
			services: {},
			start: async () => {
				throw new SeedFailedError({
					status: "failed",
					result: { exitCode: 1, stdout: "", stderr: "" },
					command: "bun run seed.ts",
					tail: ["dataQualityDuplicatesSeeder: MISSING_SECRETS"],
				});
			},
		});
		expect(code).toBe(1);
		expect(report?.failures).toHaveLength(1);
		expect(report?.failures[0]).toMatchObject({
			cause: "The seed failed with exit code 1: `bun run seed.ts`",
			step: "seed",
			output: ["dataQualityDuplicatesSeeder: MISSING_SECRETS"],
		});
		// The temp checkout has no .gitignore: that warning comes along.
		expect(report?.setupHints.join("\n")).toContain(".buncargo/ is gitignored");
		expect(report?.failures[0]?.hints).toContain(
			"Setup checks that warned before the start:",
		);
	});

	it("names the app that exited during start and shows what it printed", async () => {
		const port = 44410 + Math.floor(Math.random() * 200);
		const { code, report } = await failedRun({
			services: {},
			apps: {
				api: {
					port,
					devCommand:
						"bun -e 'console.log(\"MISSING_SECRETS: STRIPE_KEY\"); process.exit(1)'",
					healthEndpoint: false,
					requiredServices: [],
				},
			},
			waitForServers: () => new Promise(() => {}),
		});
		expect(code).toBe(1);
		const failure = report?.failures.at(-1);
		expect(failure?.cause).toContain('"api"');
		expect(failure?.step).toBe("api");
		expect(failure?.output).toContain("MISSING_SECRETS: STRIPE_KEY");
		expect(failure?.next).toEqual(["`buncargo logs api` has its whole output"]);
	});
});
