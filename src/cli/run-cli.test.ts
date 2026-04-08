import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExposeTargets, stopPublicTunnels } from "../core/tunnel";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { getFlagValue, hasFlag, runCli } from "./run-cli";
import { upsertTunnelRegistryEntries } from "./tunnel-registry";

// ═══════════════════════════════════════════════════════════════════════════
// hasFlag Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("hasFlag", () => {
	it("returns true when flag is present", () => {
		const args = ["--down", "--verbose"];

		expect(hasFlag(args, "--down")).toBe(true);
		expect(hasFlag(args, "--verbose")).toBe(true);
	});

	it("returns false when flag is absent", () => {
		const args = ["--down"];

		expect(hasFlag(args, "--up")).toBe(false);
		expect(hasFlag(args, "--reset")).toBe(false);
	});

	it("returns false for empty args array", () => {
		const args: string[] = [];

		expect(hasFlag(args, "--down")).toBe(false);
	});

	it("does not match partial flags", () => {
		const args = ["--down-all"];

		expect(hasFlag(args, "--down")).toBe(false);
	});

	it("treats --flag=value as presence of --flag", () => {
		const args = ["--timeout=10", "--verbose"];

		expect(hasFlag(args, "--timeout=10")).toBe(true);
		expect(hasFlag(args, "--timeout")).toBe(true);
	});

	it("treats --expose=name as requesting expose", () => {
		const args = ["--expose=api"];

		expect(hasFlag(args, "--expose")).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// getFlagValue Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("getFlagValue", () => {
	describe("--flag=value format", () => {
		it("parses value from --flag=value format", () => {
			const args = ["--timeout=10"];

			expect(getFlagValue(args, "--timeout")).toBe("10");
		});

		it("handles string values", () => {
			const args = ["--name=myapp"];

			expect(getFlagValue(args, "--name")).toBe("myapp");
		});

		it("handles values with special characters", () => {
			const args = ["--path=/home/user/my-project"];

			expect(getFlagValue(args, "--path")).toBe("/home/user/my-project");
		});

		it("handles empty value", () => {
			const args = ["--name="];

			expect(getFlagValue(args, "--name")).toBe("");
		});

		it("parses comma-separated expose names", () => {
			const args = ["--expose=api,web"];

			expect(getFlagValue(args, "--expose")).toBe("api,web");
		});
	});

	describe("--flag value format", () => {
		it("parses value from --flag value format", () => {
			const args = ["--timeout", "10"];

			expect(getFlagValue(args, "--timeout")).toBe("10");
		});

		it("handles string values", () => {
			const args = ["--name", "myapp"];

			expect(getFlagValue(args, "--name")).toBe("myapp");
		});

		it("handles values with paths", () => {
			const args = ["--cwd", "/home/user/project"];

			expect(getFlagValue(args, "--cwd")).toBe("/home/user/project");
		});

		it("parses expose names from separate value", () => {
			const args = ["--expose", "api,web"];

			expect(getFlagValue(args, "--expose")).toBe("api,web");
		});
	});

	describe("edge cases", () => {
		it("returns undefined when flag not found", () => {
			const args = ["--timeout", "10"];

			expect(getFlagValue(args, "--name")).toBeUndefined();
		});

		it("returns undefined when flag is at end of array with no value", () => {
			const args = ["--verbose", "--timeout"];

			expect(getFlagValue(args, "--timeout")).toBeUndefined();
		});

		it("ignores values that start with dash (another flag)", () => {
			const args = ["--timeout", "--verbose"];

			expect(getFlagValue(args, "--timeout")).toBeUndefined();
		});

		it("returns undefined for empty args array", () => {
			const args: string[] = [];

			expect(getFlagValue(args, "--timeout")).toBeUndefined();
		});

		it("prefers --flag=value format over --flag value", () => {
			const args = ["--timeout=5", "--timeout", "10"];

			expect(getFlagValue(args, "--timeout")).toBe("5");
		});

		it("handles multiple flags correctly", () => {
			const args = ["--name=myapp", "--port", "3000", "--verbose"];

			expect(getFlagValue(args, "--name")).toBe("myapp");
			expect(getFlagValue(args, "--port")).toBe("3000");
			expect(getFlagValue(args, "--verbose")).toBeUndefined();
		});
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// runCli + expose (stub env, mocked tunnel)
// ═══════════════════════════════════════════════════════════════════════════

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
	const services = options.services ?? {};
	const ports =
		options.ports ??
		Object.fromEntries(
			Object.entries(apps).map(([name, config]) => [name, config.port]),
		);
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
		projectName: "stub-cli",
		root: options.root ?? "/tmp/buncargo-cli-stub",
		composeFile: ".buncargo/docker-compose.generated.yml",
		portOffset: 0,
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
		waitForServers: async () => {},
		buildEnvVars: () => ({}),
		setPublicUrls: (urls: Record<string, string>) => {
			options.setPublicUrls?.(urls as Record<string, string>);
		},
		clearPublicUrls: () => {},
		ensureComposeFile: () => ".buncargo/docker-compose.generated.yml",
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		waitForServer: async (url: string, timeout?: number) => {
			await options.waitForServer?.(url, timeout);
		},
		logInfo: () => {},
		getExpoApiUrl: () => "http://127.0.0.1:3000",
		getFrontendPort: () => 5173,
		startHeartbeat: () => {},
		stopHeartbeat: () => {},
		spawnWatchdog: async () => {},
		stopWatchdog: () => {},
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
		expect(startCalls).toEqual([
			{
				startServers: false,
				wait: true,
				skipSeed: false,
				skipEnvironmentLog: false,
				onlyApps: ["expo"],
			},
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
			expect(setPublicUrlsCalls.at(0)).toEqual({
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
