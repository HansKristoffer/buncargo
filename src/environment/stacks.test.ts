import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config";
import {
	projectLockPath,
	withProjectLifecycleLock,
} from "../container-runtime";
import { FileLockTimeoutError } from "../core/file-lock";
import { loadRuns } from "../core/run-registry";
import { buildComposeModel } from "../docker-compose";
import { service } from "../docker-compose/services";
import type { BuncargoIntegration, DevConfig } from "../types";
import { createDevEnvironment } from "./create-dev-environment";

const saved = {
	HOME: process.env.HOME,
	BUNCARGO_PORT_OFFSET: process.env.BUNCARGO_PORT_OFFSET,
	DOCKER_HOST: process.env.DOCKER_HOST,
};
let home = "";
let root = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-stacks-home-"));
	root = mkdtempSync(join(tmpdir(), "buncargo-stacks-"));
	writeFileSync(join(root, "package.json"), "{}");
	process.env.HOME = home;
	// No probing, and no daemon to reach should anything try.
	process.env.BUNCARGO_PORT_OFFSET = "100";
	process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

function fakeStack(log: string): BuncargoIntegration {
	return {
		name: "fake",
		stacks: {
			fake: {
				up: async (ctx) => {
					appendFileSync(log, `up ${ctx.selectedServices?.join(",")}\n`);
				},
				down: ({ projectName, removeVolumes }) => [
					"sh",
					"-c",
					`echo "down ${projectName} ${removeVolumes}" >> '${log}'`,
				],
			},
		},
	};
}

function stackConfig(log: string): DevConfig {
	return {
		projectPrefix: "stk",
		services: {
			api: { port: 4100, external: { stack: "fake" } },
			db: {
				port: 4101,
				external: { stack: "fake", preset: "postgres" },
				urlTemplate: ({ host, port }) => `postgresql://${host}:${port}/db`,
			},
		},
		integrations: [fakeStack(log)],
	};
}

describe("integration stacks", () => {
	it("starts the whole stack for one of its services, records it, and stops it", async () => {
		const log = join(root, "stack.log");
		const env = createDevEnvironment(stackConfig(log), { root });

		await env.start({
			onlyServices: ["api"],
			startServers: false,
			watchdog: false,
			verbose: false,
		});

		// Selecting one service selected its sibling: one CLI starts both.
		expect(readFileSync(log, "utf8")).toBe("up api,db\n");
		expect(env.ports.api).toBe(4200);
		// The stack's CLI owns its containers; nothing went through Compose.
		expect(
			existsSync(join(root, ".buncargo/docker-compose.generated.yml")),
		).toBe(false);

		const [run] = await loadRuns();
		expect(run?.services).toEqual([
			{ name: "api", status: "starting", stack: "fake" },
			{ name: "db", status: "starting", stack: "fake" },
		]);
		expect(run?.stacks).toEqual([
			{
				name: "fake",
				down: ["sh", "-c", `echo "down ${env.projectName} false" >> '${log}'`],
			},
		]);

		await env.stop({ removeVolumes: true, verbose: false });
		expect(readFileSync(log, "utf8")).toBe(
			`up api,db\ndown ${env.projectName} true\n`,
		);
		expect(await loadRuns()).toEqual([]);
	});

	it("starts and stops the stack under the project lifecycle lock", async () => {
		const log = join(root, "locked.log");
		const probe = join(root, "lock-probe.ts");
		// The sweep skips a busy lock, so whether the lock is free while a stack
		// comes up or goes down decides whether the sweep can race it.
		writeFileSync(
			probe,
			`import { appendFileSync } from "node:fs";
import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "../core/file-lock.ts"))};
const [target, log] = process.argv.slice(2);
const held = await withFileLock(target, async () => false, { timeoutMs: 0 }).catch(() => true);
appendFileSync(log, held ? "down locked\\n" : "down free\\n");
`,
		);
		const config: DevConfig = {
			projectPrefix: "stklock",
			services: { api: { port: 4110, external: { stack: "probe" } } },
			integrations: [
				{
					name: "probe",
					stacks: {
						probe: {
							up: async (ctx) => {
								const held = await withProjectLifecycleLock(
									ctx.projectName,
									ctx.root,
									async () => false,
									{ timeoutMs: 0 },
								).catch((error) => error instanceof FileLockTimeoutError);
								appendFileSync(log, held ? "up locked\n" : "up free\n");
							},
							down: ({ projectName, root: stackRoot }) => [
								process.execPath,
								probe,
								projectLockPath(projectName, stackRoot),
								log,
							],
						},
					},
				},
			],
		};
		const env = createDevEnvironment(config, { root });

		await env.start({
			onlyServices: ["api"],
			startServers: false,
			watchdog: false,
			verbose: false,
		});
		await env.stop({ verbose: false });

		expect(readFileSync(log, "utf8")).toBe("up locked\ndown locked\n");
	});

	it("holds the project lock until every stack settled when one fails", async () => {
		const { promise: failed, resolve: fail } = Promise.withResolvers<void>();
		let lockWhileSlowCameUp = "";
		const lockFree = (ctx: { projectName: string; root: string }) =>
			withProjectLifecycleLock(ctx.projectName, ctx.root, async () => true, {
				timeoutMs: 0,
			}).catch((error) => {
				if (error instanceof FileLockTimeoutError) return false;
				throw error;
			});
		const config: DevConfig = {
			projectPrefix: "stkfail",
			services: {
				slow: { port: 4120, external: { stack: "slow" } },
				broken: { port: 4121, external: { stack: "broken" } },
			},
			integrations: [
				{
					name: "pair",
					stacks: {
						// Still coming up after its sibling failed, the way `compose up`
						// runs on while `supabase start` hits a port conflict.
						slow: {
							up: async (ctx) => {
								await failed;
								// Each probe is a real round of file operations, which is
								// what releasing the lock takes.
								for (let probe = 0; probe < 20; probe++)
									if (await lockFree(ctx)) {
										lockWhileSlowCameUp = "free";
										return;
									}
								lockWhileSlowCameUp = "held";
							},
							down: () => ["true"],
						},
						broken: {
							up: async () => {
								fail();
								throw new Error("port 54321 is already allocated");
							},
							down: () => ["true"],
						},
					},
				},
			],
		};
		const env = createDevEnvironment(config, { root });

		await expect(
			env.start({
				onlyServices: ["slow", "broken"],
				startServers: false,
				watchdog: false,
				verbose: false,
			}),
		).rejects.toThrow("port 54321 is already allocated");
		expect(lockWhileSlowCameUp).toBe("held");
		await env.stop({ verbose: false });
	});

	it("leaves external services out of the Compose file", () => {
		const model = buildComposeModel({
			db: { port: 4101, external: { stack: "fake" } },
			cache: service.redis(),
		});
		expect(Object.keys(model.services)).toEqual(["cache"]);
	});

	it("rejects a service provided by a stack no integration defines", () => {
		const config = stackConfig(join(root, "unused.log"));
		expect(
			validateConfig({
				...config,
				services: {
					...config.services,
					typo: { port: 4102, external: { stack: "fakee" } },
				},
			}),
		).toContain(
			'Service "typo" is provided by stack "fakee", which no integration defines',
		);
	});
});
