import { describe, expect, it } from "bun:test";
import { resolveExposeTargets, stopPublicTunnels } from "../core/tunnel";
import type { AppConfig, DevEnvironment, ServiceConfig } from "../types";
import { getFlagValue, hasFlag, runCli } from "./run-cli";

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

function createStubEnv(): DevEnvironment<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
> {
	return {
		services: {},
		apps: {
			api: {
				port: 3000,
				devCommand: "bun run dev",
				expose: true,
			},
		},
		ports: { api: 3000 },
		urls: { api: "http://localhost:3000" } as DevEnvironment<
			Record<string, ServiceConfig>,
			Record<string, AppConfig>
		>["urls"],
		publicUrls: {},
		projectName: "stub-cli",
		root: "/tmp/buncargo-cli-stub",
		composeFile: ".buncargo/docker-compose.generated.yml",
		portOffset: 0,
		isWorktree: false,
		localIp: "127.0.0.1",
		start: async () => null,
		stop: async () => {},
		restart: async () => {},
		isRunning: async () => true,
		startServers: async () => ({}),
		stopProcess: () => {},
		waitForServers: async () => {},
		buildEnvVars: () => ({}),
		setPublicUrls: () => {},
		clearPublicUrls: () => {},
		ensureComposeFile: () => ".buncargo/docker-compose.generated.yml",
		exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		waitForServer: async () => {},
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
});
