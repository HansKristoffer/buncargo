import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveApps, resolveServices } from "../config/resolve";
import { containerRuntimeForEnv } from "../container-runtime";
import { getRoutesPath } from "../core/hosts";
import { acquireLease, readLeases, releaseLeases } from "../core/leases";
import { listRunLogDirs } from "../core/process/app-logs";
import { isProcessAlive } from "../core/process/lifecycle";
import {
	buildRunEntry,
	findRunsByRoot,
	loadRuns,
	publishRun,
	retireRuns,
} from "../core/run-registry";
import { createPhaseTimer } from "../core/timing";
import { resolveExposeTargets, stopPublicTunnels } from "../core/tunnel";
import { createDevEnvironment, type PrepareOptions } from "../environment";
import type { DevEnvContext } from "../environment/context";
import { registerInternals } from "../environment/internals";
import { createAppPipeline } from "../environment/pipeline";
import { createRunClaimApi } from "../environment/run-claim";
import { SeedFailedError } from "../environment/seed-startup";
import { planStart } from "../planning";
import type {
	AppConfig,
	DevConfig,
	DevEnvironment,
	ServiceConfig,
} from "../types";
import { type DetachedReport, readDetachedReport } from "./dev-detach";
import { requestRestart } from "./restart-requests";
import { decideSpawn, runCli, withTakenOver } from "./run-cli";
import * as takeover from "./takeover";

// ═══════════════════════════════════════════════════════════════════════════
// runCli + expose (stub env, mocked tunnel)
// ═══════════════════════════════════════════════════════════════════════════

// `runCli` publishes every run into `~/.buncargo/runs.json`. Point HOME at a
// temp dir so tests never write the developer's real registry, and restore it
// afterwards: the whole suite shares one process.
let stateHome: string;
const realHome = process.env.HOME;
// The stub's checkout when a test names none. A full run checks that each
// app's cwd exists, so it must be a real directory, made fresh on every
// machine: a fixed path only exists where some earlier run left it.
const stubRoot = mkdtempSync(join(tmpdir(), "buncargo-cli-stub-"));

beforeAll(() => {
	stateHome = mkdtempSync(join(tmpdir(), "buncargo-cli-state-"));
	process.env.HOME = stateHome;
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(stateHome, { recursive: true, force: true });
	rmSync(stubRoot, { recursive: true, force: true });
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

/**
 * Stands in for the environment's preparation; `notify` is where the run
 * says what it reports before its output opens.
 */
type StubPrepare = (
	options: PrepareOptions,
	notify: (message: string, problem: boolean) => void,
) => Promise<void>;

function createStubEnv(
	options: {
		apps?: Record<string, AppConfig>;
		services?: Record<string, ServiceConfig>;
		ports?: Record<string, number>;
		root?: string;
		prepare?: StubPrepare;
		waitForServer?: (url: string, timeout?: number) => Promise<void>;
		waitForServers?: (options?: {
			onlyApps?: string[];
		}) => void | Promise<void>;
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
	const env = {
		services: resolveServices(services),
		apps: resolveApps(apps),
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
		prepareStartAsync: async () => {},
		resolvePrimaryApp: (selected?: readonly string[]) =>
			(selected ?? Object.keys(apps))[0],
		root: options.root ?? stubRoot,
		composeFile: ".buncargo/docker-compose.generated.yml",
		containerRuntime: "docker",
		portOffset: 0,
		portOffsetProvenance: "hash",
		isWorktree: false,
		localIp: "127.0.0.1",
		start: async () => null,
		stop: async () => {},
		isRunning: async () => true,
		startServers: async () => ({}),
		waitForServers: async (waitOptions?: { onlyApps?: string[] }) => {
			await options.waitForServers?.(waitOptions);
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
		details: () => ({}),
		getExpoApiUrl: () => "http://127.0.0.1:3000",
		getFrontendPort: () => 5173,
		sessionId: "test-session",
		claimRun: async () => {},
		releaseRun: async () => {},
		ensureWatchdog: async () => {},
		withSuffix: () =>
			createStubEnv() as DevEnvironment<
				Record<string, ServiceConfig>,
				Record<string, AppConfig>
			>,
		openPublicTunnels: async () => {
			throw new Error("not used");
		},
		runSeed: async () => ({ status: "not-configured" }),
	} as unknown as DevEnvironment<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	registerStubInternals(env, options.prepare);
	return env;
}

/**
 * The phases the CLI drives: `prepare` stubbed, the apps through the real
 * pipeline over the stub's members, its leases and rows under the stub's
 * session.
 */
function registerStubInternals(
	env: DevEnvironment<Record<string, ServiceConfig>, Record<string, AppConfig>>,
	prepare: StubPrepare | undefined,
): void {
	let report: (message: string, problem: boolean) => void = () => {};
	const claim = createRunClaimApi(
		{
			projectName: env.projectName,
			root: env.root,
			worktree: false,
			config: { projectPrefix: env.projectPrefix, services: env.services },
			services: env.services,
			selectedServiceKeys: [],
			hasSelectedServices: false,
			runtime: { name: "docker" },
		} as unknown as DevEnvContext,
		() => env,
	);
	Object.assign(env, { sessionId: claim.sessionId });
	const pipeline = createAppPipeline({
		root: env.root,
		ports: env.ports as Record<string, number>,
		projectName: env.projectName,
		unsetEnv: undefined,
		runtime: () => containerRuntimeForEnv(env),
		appEnv: (name) => env.buildAppEnvVars(name),
		runHook: async () => {},
		waitForHealth: (apps, _production, signal) =>
			env.waitForServers({ onlyApps: Object.keys(apps), signal }),
		recordCapture: async () => [],
		renderGeneratedFiles: () => [],
		runSeed: (seedOptions) => env.runSeed(seedOptions),
		// Like the stub's `releaseRun`: a failed run's rows stay for the test
		// to read once it has ended.
		claim: { ...claim, abandonApps: async () => {} },
		ensureWatchdog: () => {},
		ownedServerPids: {},
	});
	registerInternals(env, {
		...pipeline,
		prepare: async (prepareOptions = {}) => {
			await prepare?.(prepareOptions, (message, problem) =>
				report(message, problem),
			);
			const plan = planStart(env.apps, env.services, {
				onlyApps: prepareOptions.onlyApps,
			});
			return {
				selection: {
					appNames: plan.appNames,
					requiredServiceKeys: plan.requiredServiceKeys,
				},
				apps: plan.apps,
				hasServices: plan.requiredServiceKeys.length > 0,
				productionBuild: false,
				verbose: false,
				watchdog: prepareOptions.watchdog !== false,
				seed:
					prepareOptions.seed === "force"
						? { kind: "ran", outcome: await env.runSeed({ force: true }) }
						: { kind: "none" },
				onPhase: prepareOptions.onPhase,
			};
		},
		secretsSession: async () => {},
		notify: (next) => {
			report = next;
		},
		renderGeneratedFiles: () => [],
		recordCapture: async () => [],
	});
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

/**
 * Dev commands that run until their health check was asked for, then exit 0:
 * the run ends once its apps were up.
 */
function exitsOnceChecked(root: string) {
	const marker = (name: string) => join(root, `${name}.checked`);
	return {
		devCommand: (name: string) =>
			`bun -e ${JSON.stringify(`setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(marker(name))})) process.exit(0); }, 20)`)}`,
		checked: (name: string) => writeFileSync(marker(name), ""),
	};
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

	// `buncargo dev api` started every app: the positional was never read.
	it.each([[["--migrate", "--apps=expo"]], [["--migrate", "expo"]]])(
		"passes the apps %p selects into the preparation",
		async (args) => {
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
						prepare: async (startOptions) => {
							startCalls.push(startOptions);
						},
					}),
					{
						args,
						watchdog: false,
					},
				),
			);

			expect(code).toBe(0);
			expect(startCalls).toMatchObject([
				{
					startServers: false,
					wait: true,
					seed: "skip",
					prepare: "migrate",
					onlyApps: ["expo"],
					autoStartDocker: undefined,
					// Development in CI too, like the dev servers it goes on to run.
					productionBuild: false,
				},
			]);
		},
	);

	it("forces the seed in preparation for --seed, so its secrets come with the containers'", async () => {
		const startCalls: unknown[] = [];
		const env = createStubEnv({
			prepare: async (startOptions) => {
				startCalls.push(startOptions);
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
		expect(startCalls).toMatchObject([{ seed: "force", prepare: "all" }]);
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
			await publishTunnelOwner(root, "tunnel-owner", apiPort);

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
			await retireRuns(
				(await loadRuns()).filter((run) =>
					["tunnel-owner"].includes(run.sessionId),
				),
			);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await rm(root, { recursive: true, force: true });
		}
	});
});

/**
 * The live run (this process) that serves `api` on `port` through a public
 * tunnel, as `runs.json` records it.
 */
async function publishTunnelOwner(
	root: string,
	sessionId: string,
	port: number,
): Promise<void> {
	await publishRun({
		...buildRunEntry({
			sessionId,
			projectPrefix: "stub",
			projectName: "stub-cli",
			root,
			isWorktree: false,
		}),
		apps: [
			{
				name: "api",
				port,
				url: `http://localhost:${port}`,
				loopbackUrl: `http://localhost:${port}`,
				publicUrl: "https://api.example.com",
				status: "ready",
			},
		],
	});
}

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
		await publishTunnelOwner(root, "inherited-tunnel-owner", apiPort);
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
		await retireRuns(
			(await loadRuns()).filter((run) =>
				["inherited-tunnel-owner"].includes(run.sessionId),
			),
		);
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
		const healthChecked: string[] = [];
		const app = exitsOnceChecked(root);
		const env = createStubEnv({
			root,
			apps: {
				api: { port: apiPort, devCommand: app.devCommand("api") },
				expoApp: {
					port: expoPort,
					devCommand: app.devCommand("expoApp"),
					needsPublicUrls: true,
				},
			},
			waitForServers: (waitOptions) => {
				for (const name of waitOptions?.onlyApps ?? []) {
					healthChecked.push(name);
					app.checked(name);
				}
			},
		});

		try {
			await runCli(env, { args: [], watchdog: false });
			expect(healthChecked.sort()).toEqual(["api", "expoApp"]);
		} finally {
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
				// Started, then never answers.
				waitForServers: async () => {
					const started = Bun.file(join(root, "api-started"));
					while (!(await started.exists())) await Bun.sleep(20);
					throw new Error("api did not respond");
				},
			});
			const stdinTTY = process.stdin.isTTY;
			process.stdin.isTTY = false;
			const said: string[] = [];
			const realLog = console.log;
			console.log = (...parts: unknown[]) => said.push(parts.join(" "));
			try {
				// The stub app never answers, which ends the run: only that it
				// was spawned matters here.
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
			await retireRuns(
				(await loadRuns()).filter(
					(run) => run.sessionId === "unhealthy-sibling",
				),
			);
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

// The startup benchmark times exactly this: a Ctrl-C while apps come up.
it("prints the --timing report for a run interrupted before its apps were ready", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "buncargo-interrupted-timing-")),
	);
	const reports: string[] = [];
	const awaitingReadiness = Promise.withResolvers<void>();
	const env = createStubEnv({
		root,
		services: {},
		apps: {
			api: {
				port: 44910 + Math.floor(Math.random() * 100),
				devCommand: "bun -e 'setInterval(() => {}, 1000)'",
				requiredServices: [],
			},
		},
		// Never ready: the interrupt lands during app readiness.
		waitForServers: () => {
			awaitingReadiness.resolve();
			return new Promise(() => {});
		},
	});
	const run = withProcessExitTrap(() =>
		runCli(env, {
			args: ["--no-hosts", "--no-tui"],
			watchdog: false,
			timer: createPhaseTimer({
				json: true,
				log: (line) => reports.push(line),
			}),
		}),
	);
	try {
		await awaitingReadiness.promise;
		expect(reports).toEqual([]);
		process.emit("SIGINT");
		expect(await run).toBe(130);
		expect(reports).toHaveLength(1);
		expect(JSON.parse(reports[0] ?? "")).toMatchObject({
			type: "buncargo.startup",
		});
	} finally {
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
				throw new Error(`jobs never became ${want}: ${await status()}`);
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

/**
 * A run of one app that keeps going until the run stops it: its exit code,
 * the app's pid once it is ready, and the warnings the run printed.
 */
async function startLongRunningApp(
	prefix: string,
	overrides: Partial<
		DevEnvironment<Record<string, ServiceConfig>, Record<string, AppConfig>>
	> = {},
) {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	const env = createStubEnv({
		root,
		services: {},
		apps: {
			api: {
				port: 45010 + Math.floor(Math.random() * 200),
				devCommand: "bun -e 'setInterval(() => {}, 1000)'",
				healthEndpoint: false,
				requiredServices: [],
			},
		},
	});
	Object.assign(env, overrides);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	const exit = withProcessExitTrap(() =>
		runCli(env, { args: ["--no-hosts", "--no-tui"], watchdog: false }),
	);
	return {
		exit,
		warnings: () =>
			warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n"),
		async readyPid(): Promise<number> {
			const deadline = performance.now() + 5_000;
			for (;;) {
				const app = (await findRunsByRoot(root))
					.find((run) => run.sessionId === env.sessionId)
					?.apps.find((entry) => entry.name === "api");
				if (app?.status === "ready" && app.pid) return app.pid;
				if (performance.now() > deadline) throw new Error("api never ready");
				await Bun.sleep(20);
			}
		},
		async cleanup(): Promise<void> {
			if (
				!(await Promise.race([exit.then(() => true), Promise.resolve(false)]))
			)
				process.emit("SIGTERM");
			await exit.catch(() => {});
			warn.mockRestore();
			await rm(root, { recursive: true, force: true });
		},
	};
}

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

	// The registry is read strictly now, so a corrupt one threw before the
	// containers were stopped, and `--down` left them all running.
	it("stops the containers on --down when the routes registry is corrupt", async () => {
		const routesPath = getRoutesPath();
		mkdirSync(dirname(routesPath), { recursive: true });
		writeFileSync(routesPath, "{ not json");
		let stopped = 0;
		const warnings: string[] = [];
		const warn = spyOn(console, "warn").mockImplementation((...parts) => {
			warnings.push(parts.join(" "));
		});
		const env = createStubEnv();
		Object.assign(env, {
			stop: async () => {
				stopped++;
			},
		});
		try {
			const code = await withProcessExitTrap(() =>
				runCli(env, { args: ["--down"], watchdog: false }),
			);
			expect(code).toBe(0);
			expect(stopped).toBe(1);
			expect(warnings.join("\n")).toContain(routesPath);
		} finally {
			warn.mockRestore();
			rmSync(routesPath, { force: true });
		}
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

	// An exception nothing caught used to kill the CLI and leave every app
	// running; it now ends the run as a failure does.
	it("stops every app when the run crashes, and exits 1", async () => {
		const run = await startLongRunningApp("buncargo-crash-");
		try {
			const pid = await run.readyPid();
			process.emit("uncaughtException", new Error("boom"));
			expect(await run.exit).toBe(1);
			expect(isProcessAlive(pid)).toBe(false);
		} finally {
			await run.cleanup();
		}
	});

	it("warns when releasing the run at Ctrl-C fails, and still ends it", async () => {
		const run = await startLongRunningApp("buncargo-release-fails-", {
			releaseRun: async () => {
				throw new Error("registry lock timed out");
			},
		});
		try {
			await run.readyPid();
			process.emit("SIGINT");
			expect(await run.exit).toBe(130);
			expect(run.warnings()).toContain(
				"Could not release this run in ~/.buncargo/runs.json: Error: registry lock timed out",
			);
		} finally {
			await run.cleanup();
		}
	});

	// `start()` warns where the run's service changes are said, and said it
	// before the CLI wired that to the run's output: only the console had it.
	it("keeps what start() reported before the run's output opened in its log", async () => {
		const root = await realpath(
			await mkdtemp(join(tmpdir(), "buncargo-early-")),
		);
		const env = createStubEnv({
			root,
			services: {},
			apps: {
				api: {
					port: 44510 + Math.floor(Math.random() * 100),
					devCommand: "bun -e 'process.exit(0)'",
					healthEndpoint: false,
					requiredServices: [],
				},
			},
			prepare: async (_options, notify) => {
				notify("The watchdog did not start (runner missing).", true);
			},
		});
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			await runCli(env, { args: ["--no-hosts", "--no-tui"], watchdog: false });
			const [dir] = listRunLogDirs(root);
			expect(
				readFileSync(join(dir as string, "buncargo.log"), "utf8"),
			).toContain("The watchdog did not start (runner missing).");
		} finally {
			warn.mockRestore();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refuses --detach=1 rather than reading it as --detach", async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const code = await withProcessExitTrap(() =>
				runCli(createStubEnv(), { args: ["--detach=1"], watchdog: false }),
			);
			expect(code).toBe(1);
			const printed = error.mock.calls
				.map((call) => String(call[0]))
				.join("\n");
			expect(printed).toContain("--detach takes no value");
		} finally {
			error.mockRestore();
		}
	});

	// A background run handed --detach would start another, without end.
	it("refuses --detach in a run that is already in the background", async () => {
		const error = spyOn(console, "error").mockImplementation(() => {});
		process.env.BUNCARGO_DETACHED = "1";
		try {
			const code = await withProcessExitTrap(() =>
				runCli(createStubEnv(), { args: ["--detach"], watchdog: false }),
			);
			expect(code).toBe(1);
			const printed = error.mock.calls
				.map((call) => String(call[0]))
				.join("\n");
			expect(printed).toContain("already in the background");
		} finally {
			delete process.env.BUNCARGO_DETACHED;
			error.mockRestore();
		}
	});

	// A step that takes no signal finishes, and the run stops at the next
	// boundary instead of claiming containers and starting them.
	it("claims nothing once interrupted, and exits 130", async () => {
		let claims = 0;
		const env = createStubEnv({
			prepare: async () => {
				claims++;
			},
		});
		Object.assign(env, {
			prepareStartAsync: async () => {
				process.emit("SIGINT");
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
			prepare: async () => {
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

// `dev` used to rebuild the leases, the rows and the hooks a library start
// had, and the two drifted: only the library gave a refused essential app's
// leases back. One pipeline now; both entry points must leave the same
// claim, leases, rows and hooks behind for the same config.
it("claims, leases, publishes and hooks the same through runCli and start()", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "buncargo-parity-")),
	);
	writeFileSync(join(root, "package.json"), "{}");
	const port = 45010 + Math.floor(Math.random() * 400);
	const hooks: string[] = [];
	type Snapshot = {
		hooks: string[];
		services: { name: string; stack?: string }[];
		stacks: string[] | undefined;
		apps: string[];
		leases: string[];
	};
	const snapshots: Snapshot[] = [];
	let afterSnapshot = () => {};
	const snapshot = async () => {
		const [run] = await findRunsByRoot(root);
		snapshots.push({
			hooks: [...hooks],
			services: (run?.services ?? []).map(({ name, stack }) => ({
				name,
				stack,
			})),
			stacks: run?.stacks?.map((stack) => stack.name),
			apps: (run?.apps ?? []).map((app) => app.name),
			leases: (await readLeases())
				.filter((lease) => lease.sessionId === run?.sessionId)
				.map((lease) => lease.key),
		});
		hooks.length = 0;
		afterSnapshot();
	};
	const config: DevConfig = {
		projectPrefix: "parity",
		services: { queue: { port: port + 1, external: { stack: "fake" } } },
		apps: {
			web: {
				port,
				devCommand: `${process.execPath} -e "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') }); setInterval(() => {}, 1000)"`,
				healthEndpoint: "/",
				requiredServices: ["queue"],
				exclusive: "parity:web",
			},
		},
		integrations: [
			{
				name: "fake",
				stacks: {
					fake: {
						up: async () => void hooks.push("stack up"),
						down: () => ["true"],
					},
				},
			},
		],
		hooks: {
			beforeServers: async () => void hooks.push("beforeServers"),
			afterServers: snapshot,
		},
		options: { hosts: false, verbose: false, worktreeIsolation: false },
	};
	const savedOffset = process.env.BUNCARGO_PORT_OFFSET;
	process.env.BUNCARGO_PORT_OFFSET = "0";
	const log = spyOn(console, "log").mockImplementation(() => {});
	try {
		const library = createDevEnvironment(config, { root });
		await library.start({ watchdog: false });
		await library.stop({ force: true, verbose: false });

		const cli = createDevEnvironment(config, { root });
		afterSnapshot = () => process.emit("SIGINT");
		await withProcessExitTrap(() =>
			runCli(cli, { args: ["--no-hosts", "--no-tui"], watchdog: false }),
		);
		await cli.stop({ force: true, verbose: false });

		const [fromStart, fromCli] = snapshots;
		expect(fromStart).toEqual({
			hooks: ["stack up", "beforeServers"],
			services: [{ name: "queue", stack: "fake" }],
			stacks: ["fake"],
			apps: ["web"],
			leases: ["parity:web"],
		});
		expect(fromCli).toEqual(fromStart);
	} finally {
		log.mockRestore();
		if (savedOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
		else process.env.BUNCARGO_PORT_OFFSET = savedOffset;
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);

describe("the spawn set", () => {
	const apps = resolveApps({
		api: { port: 3000, devCommand: "bun api" },
		web: { port: 3001, devCommand: "bun web" },
	});

	it("moves taken-over apps from reused to started", () => {
		const classified = {
			startApps: { web: apps.web },
			reusedApps: { api: apps.api },
			startNames: ["web"],
			reusedNames: ["api"],
			inferredReuseNames: ["api"],
			unhealthy: [
				{
					name: "api",
					port: 3000,
					url: "http://localhost:3000",
					detached: true,
				},
			],
		};

		expect(
			withTakenOver(classified, { names: ["api"], apps: { api: apps.api } }),
		).toEqual({
			startApps: { web: apps.web, api: apps.api },
			reusedApps: {},
			startNames: ["web", "api"],
			reusedNames: [],
			inferredReuseNames: [],
			unhealthy: [],
		});
	});

	it("spawns, holds, ends or refuses by what is left to run", () => {
		const nothing = {
			startNames: [],
			reusedNames: [],
			leaseSkips: 0,
			servicesOnly: false,
			pendingTunnels: false,
			sharing: false,
		};

		expect(decideSpawn({ ...nothing, startNames: ["web"] })).toBe("spawn");
		expect(decideSpawn({ ...nothing, reusedNames: ["web"] })).toBe(
			"already-running",
		);
		expect(decideSpawn({ ...nothing, servicesOnly: true })).toBe("hold");
		expect(
			decideSpawn({ ...nothing, reusedNames: ["web"], sharing: true }),
		).toBe("hold");
		// Its only app's lease is held elsewhere: there is no run to have.
		expect(decideSpawn({ ...nothing, leaseSkips: 1 })).toBe("refuse");
		// Tunnels it opens are still a run.
		expect(
			decideSpawn({ ...nothing, leaseSkips: 1, pendingTunnels: true }),
		).toBe("hold");
	});
});
