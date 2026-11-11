import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	resolveApp,
	resolveApps,
	resolveService,
	resolveServices,
} from "../config/resolve";
import {
	fakeRuntime,
	runtimeContainer,
} from "../container-runtime/fake-runtime.testing";
import { waitForDevServers } from "../core/network";
import { readRemovals } from "../core/removal-log";
import { buildRunEntry, publishRun, retireRuns } from "../core/run-registry";
import { CI_ENV_VARS } from "../core/runtime-flags";
import { InfisicalLoginError } from "../core/secrets/errors";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import {
	clearScopeSecretsCache,
	loadScopeSecrets,
	resolveScope,
} from "../core/secrets/index";
import { isolateHome } from "../core/test-env.testing";
import { planStart } from "../planning";
import type { ResolvedApp } from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import { createLifecycleApi } from "./lifecycle";
import { LifecycleCoordinator } from "./lifecycle-coordinator";
import { createAppPipeline } from "./pipeline";
import { createServerHookRunner } from "./servers";
import { createServiceWatch } from "./service-watch";

// Starting and stopping take the project's lifecycle lock and record the
// removal under `~/.buncargo`: a home of the test's own, never the developer's.
isolateHome("buncargo-lifecycle-");

function fixture() {
	const events: string[] = [];
	const services = resolveServices({ db: { port: 5432, healthCheck: false } });
	const apps = resolveApps({
		web: {
			port: 3000,
			requiredServices: ["db"],
			devCommand: "exit 0",
			healthEndpoint: false,
		},
	});
	// Not started: the first listing fails, so a start asks it to start.
	const runtime = fakeRuntime({
		containers: async () => {
			throw new Error("Cannot connect to the Docker daemon");
		},
		ensureRunning: async () => {
			events.push("runtime");
		},
		up: async () => {
			events.push("up");
		},
	});
	const config = {
		services,
		apps,
		projectPrefix: "test",
		options: { verbose: false },
		migrations: [{ name: "schema", command: "migrate" }],
		prisma: { service: "db", generate: "generate" },
		seed: {
			command: "unused",
			check: async () => {
				events.push("seed check");
				return false;
			},
		},
		hooks: {
			afterContainersReady: async () => {
				events.push("container hook");
			},
			beforeServers: async () => {
				events.push("before");
			},
			afterServers: async () => {
				events.push("after");
			},
		},
	};
	const ctx = {
		config,
		services,
		apps,
		runtime,
		root: tmpdir(),
		projectName: "test",
		ownedServerPids: {},
		ports: {},
		urls: {},
		loopbackUrls: {},
		ensureComposeFile: () => {
			events.push("artifact");
		},
		composeModel: () => ({ services: { db: { image: "postgres:16" } } }),
	} as unknown as DevEnvContext;
	ctx.getStartPlan = (onlyApps, onlyServices) =>
		planStart(ctx.apps, ctx.services, { onlyApps, onlyServices });
	ctx.prepareStartAsync = async () => {};
	ctx.captureThrowawayClaim = () => async () => {
		events.push("release claim");
	};

	const envVars = {
		getHookContext: () => ({}),
		buildEnvVars: () => ({}),
		buildAppEnvVarsMap: () => ({ web: {} }),
		buildAppEnvVars: () => ({}),
		exec: async (command: string) => {
			events.push(command);
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	} as unknown as DevEnvVarsApi;
	const runClaim = {
		sessionId: "test-session",
		claimedAt: undefined,
		claimRun: async () => {
			events.push("claim");
		},
		releaseRun: async () => {
			events.push("release");
		},
		retireRun: async () => {
			events.push("retire");
		},
		servicesReady: () => {},
		ensureWatchdog: async () => {
			events.push("watchdog");
		},
		claimApps: async (apps: Record<string, ResolvedApp>) => ({
			apps,
			skipped: [],
		}),
		appEvents: {},
		abandonApps: async () => {},
		releaseApps: async () => {
			events.push("release apps");
		},
	};
	const serviceWatch = createServiceWatch(ctx, runClaim.sessionId);
	const appPipeline = createAppPipeline({
		root: ctx.root,
		ports: {},
		projectName: ctx.projectName,
		unsetEnv: undefined,
		runtime: () => runtime,
		appEnv: (name, production) => envVars.buildAppEnvVars(name, production),
		runHook: createServerHookRunner(ctx, envVars),
		waitForHealth: (apps, productionBuild, signal) =>
			waitForDevServers(apps, {}, { productionBuild, signal, verbose: false }),
		recordCapture: async () => [],
		renderGeneratedFiles: () => [],
		runSeed: (options) => lifecycle.runSeed(options),
		claim: runClaim,
		ensureWatchdog: () => lifecycle.ensureWatchdog(),
		ownedServerPids: ctx.ownedServerPids,
	});
	const lifecycle = createLifecycleApi(
		ctx,
		envVars,
		runClaim,
		new LifecycleCoordinator(),
		serviceWatch,
		appPipeline,
	);
	return { events, ctx, envVars, runClaim, serviceWatch, lifecycle };
}

describe("startup modes and hooks", () => {
	it("containers-only skips migrations, generation, seed, and server hooks", async () => {
		const { events, lifecycle } = fixture();
		await lifecycle.start({
			prepare: "containers",
			startServers: false,
			verbose: false,
			wait: false,
		});
		// The claim precedes the first container, so the sweep never sees one
		// unowned, and the watchdog is ensured right behind it.
		expect(events).toEqual(["claim", "watchdog", "artifact", "runtime", "up"]);
	});
	it("migrate-only applies migrations without generation or seeds", async () => {
		const { events, lifecycle } = fixture();
		await lifecycle.start({
			prepare: "migrate",
			startServers: false,
			verbose: false,
			wait: false,
		});
		expect(events).toEqual([
			"claim",
			"watchdog",
			"artifact",
			"runtime",
			"up",
			"bunx --no-install prisma migrate deploy",
			"migrate",
		]);
	});
	it("library preparation does not fire server hooks without servers", async () => {
		const { events, lifecycle } = fixture();
		await lifecycle.start({ startServers: false, verbose: false, wait: false });
		expect(events).toEqual([
			"claim",
			"watchdog",
			"artifact",
			"runtime",
			"up",
			"bunx --no-install prisma migrate deploy",
			"migrate",
			"generate",
			"container hook",
			"seed check",
		]);
	});
	it("fires server hooks once around server readiness", async () => {
		const { events, lifecycle } = fixture();
		await lifecycle.start({ verbose: false, wait: false });
		expect(events.slice(-2)).toEqual(["before", "after"]);
		expect(events.filter((event) => event === "before")).toHaveLength(1);
		expect(events.filter((event) => event === "after")).toHaveLength(1);
	});
	it("an explicit generation check can skip generation while retaining migrations", async () => {
		const { ctx, events, lifecycle } = fixture();
		if (!ctx.config.prisma) throw new Error("fixture needs prisma");
		ctx.config.prisma.generateCheck = () => false;
		await lifecycle.start({ startServers: false, verbose: false, wait: false });
		expect(events).toContain("migrate");
		expect(events).not.toContain("generate");
	});
	it('generateCheck "schema-hash" generates only when the schema changed since the last generate', async () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-generate-check-"));
		const schema = join(root, "packages/prisma/prisma/schema.prisma");
		mkdirSync(dirname(schema), { recursive: true });
		writeFileSync(schema, "model User { id Int @id }");
		const startIn = async () => {
			const { ctx, events, lifecycle } = fixture();
			if (!ctx.config.prisma) throw new Error("fixture needs prisma");
			Object.assign(ctx, { root });
			Object.assign(ctx.config.prisma, { generateCheck: "schema-hash" });
			await lifecycle.start({
				startServers: false,
				verbose: false,
				wait: false,
			});
			return events.includes("generate");
		};
		try {
			expect(await startIn()).toBe(true);
			expect(await startIn()).toBe(false);
			writeFileSync(schema, "model User { id Int @id\n name String }");
			expect(await startIn()).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("a library start ensures the watchdog unless told not to", async () => {
		// Only the CLI used to start one, so a script that started containers
		// and then crashed left them for somebody's next CLI command.
		const { events, lifecycle } = fixture();
		await lifecycle.start({
			prepare: "containers",
			startServers: false,
			verbose: false,
			wait: false,
			watchdog: false,
		});
		expect(events).toEqual(["claim", "artifact", "runtime", "up"]);
	});
	it("an app-only start ensures the watchdog once its apps are up, unless told not to", async () => {
		// The watchdog lists live runs to BuncargoBar on the tailnet, and a run
		// without containers is in the registry for its apps alone.
		for (const watchdog of [true, false]) {
			const { ctx, events, lifecycle } = fixture();
			ctx.apps.site = resolveApp({
				port: 3001,
				devCommand: "exit 0",
				healthEndpoint: false,
			});
			await lifecycle.start({ onlyApps: ["site"], verbose: false, watchdog });
			expect(events).toEqual(
				watchdog ? ["before", "after", "watchdog"] : ["before", "after"],
			);
		}
	});
	it("an explicit stop retires the claim rather than holding it, and records the removal", async () => {
		const { ctx, events, lifecycle } = fixture();
		ctx.runtime.down = async () => {
			events.push("down");
		};
		await lifecycle.start({
			prepare: "containers",
			startServers: false,
			verbose: false,
			wait: false,
		});
		await lifecycle.stop({ verbose: false });
		// The containers are gone, so there is nothing to hold them for, and a
		// throwaway environment's block goes back.
		expect(events.slice(-3)).toEqual(["down", "retire", "release claim"]);
		// And a run that was using them can say who took them.
		expect(readRemovals()).toMatchObject([
			{
				projectName: "test",
				runtime: "docker",
				reason: "stopped",
				owner: { sessionId: "test-session", pid: process.pid },
				by: { pid: process.pid },
			},
		]);
	});
	it("keeps the services another live run of the project uses, and tears them down with force", async () => {
		const { ctx, events, lifecycle } = fixture();
		ctx.runtime.down = async () => {
			events.push("down");
		};
		// A second run in this checkout, claimed as every run claims before
		// its first container: two `ci` runs once shared one project, and the
		// first to finish removed the other's database mid-test.
		const other = buildRunEntry({
			sessionId: "other-run",
			projectPrefix: "test",
			projectName: ctx.projectName,
			root: ctx.root,
			isWorktree: false,
		});
		await publishRun(other);
		try {
			const start = () =>
				lifecycle.start({
					prepare: "containers",
					startServers: false,
					verbose: false,
					wait: false,
				});
			await start();
			await lifecycle.stop({ verbose: false });
			// Released for the other run, its block and containers intact.
			expect(events).not.toContain("down");
			expect(events.at(-1)).toBe("release");

			await start();
			await lifecycle.stop({ verbose: false, force: true });
			expect(events.slice(-3)).toEqual(["down", "retire", "release claim"]);
		} finally {
			await retireRuns([other]);
		}
	});
	it("stops the apps, their leases, the containers and the entry when beforeStop throws, then rejects with its error", async () => {
		const { ctx, events, lifecycle } = fixture();
		ctx.runtime.down = async () => {
			events.push("down");
		};
		const hookFailed = new Error("beforeStop failed");
		ctx.config.hooks = {
			beforeStop: async () => {
				throw hookFailed;
			},
		};
		ctx.apps.web.devCommand = "sleep 60";
		const pids = await lifecycle.start({ verbose: false, wait: false });
		const app = pids?.web;
		if (app === undefined) throw new Error("web did not start");

		await expect(lifecycle.stop({ verbose: false })).rejects.toBe(hookFailed);

		expect(() => process.kill(app, 0)).toThrow();
		expect(events.slice(-4)).toEqual([
			"release apps",
			"artifact",
			"down",
			"retire",
		]);
		// A stop that failed gives no block back.
		expect(events).not.toContain("release claim");
	});
	it("says once that the watchdog did not start, where the run's service changes are said", async () => {
		// Swallowed, a missing runner left nothing sweeping until a `ls`.
		const { lifecycle, runClaim, serviceWatch } = fixture();
		const said: [string, boolean][] = [];
		serviceWatch.report((message, problem) => said.push([message, problem]));
		let attempt: Promise<void> = Promise.resolve();
		runClaim.ensureWatchdog = () => {
			attempt = Promise.reject(new Error("runner missing"));
			return attempt;
		};
		for (const _ of [1, 2]) {
			await lifecycle.start({
				prepare: "containers",
				startServers: false,
				verbose: false,
				wait: false,
			});
			// Settles after the lifecycle's own handler, attached first.
			await attempt.catch(() => {});
		}
		expect(said).toEqual([[expect.stringContaining("runner missing"), true]]);
	});
	it("stop tears down the containers a start brought up, whatever a later start selected", async () => {
		const { ctx, events, lifecycle } = fixture();
		ctx.runtime.down = async () => {
			events.push("down");
		};
		const containersOnly = {
			prepare: "containers",
			startServers: false,
			verbose: false,
			wait: false,
		} as const;
		await lifecycle.start(containersOnly);
		await lifecycle.start({ ...containersOnly, onlyServices: [] });
		await lifecycle.stop({ verbose: false });
		expect(events.slice(-3)).toEqual(["down", "retire", "release claim"]);

		// Once torn down, a start of no services leaves containers alone.
		events.length = 0;
		await lifecycle.start({ ...containersOnly, onlyServices: [] });
		await lifecycle.stop({ verbose: false });
		expect(events).not.toContain("down");
	});
	it("reads as running with every service up, a finished job included", async () => {
		// A job's container exits once it has run, which read as not running.
		const { ctx, lifecycle } = fixture();
		ctx.services.schema = resolveService("schema", {
			kind: "job",
			rerun: "always",
		});
		ctx.runtime.containers = async () => [
			runtimeContainer({ labels: { project: ctx.projectName, service: "db" } }),
			runtimeContainer({
				state: "exited",
				labels: { project: ctx.projectName, service: "schema" },
			}),
		];
		await lifecycle.start({
			prepare: "containers",
			startServers: false,
			verbose: false,
			wait: false,
		});
		expect(await lifecycle.isRunning()).toBe(true);

		ctx.runtime.containers = async () => [
			runtimeContainer({
				state: "exited",
				labels: { project: ctx.projectName, service: "db" },
			}),
		];
		expect(await lifecycle.isRunning()).toBe(false);
	});
	it("rejects an invalid selection before writing the artifact or starting runtime", async () => {
		const { events, lifecycle } = fixture();
		await expect(lifecycle.start({ onlyApps: ["missing"] })).rejects.toThrow(
			"Unknown app",
		);
		expect(events).toEqual([]);
	});
	it("honors cancellation before startup mutations", async () => {
		const { events, lifecycle } = fixture();
		await expect(
			lifecycle.start({ signal: AbortSignal.abort(new Error("cancelled")) }),
		).rejects.toThrow("cancelled");
		expect(events).toEqual([]);
	});
});

describe("withServices", () => {
	it("claims and starts the services, runs the command, then releases them however it ends", async () => {
		const { events, lifecycle } = fixture();
		const order: string[] = [];
		const result = await lifecycle.withServices(
			["db"],
			{ verbose: false, wait: false, watchdog: false },
			async () => {
				order.push(...events);
				return 7;
			},
		);
		expect(result).toBe(7);
		expect(order.slice(0, 2)).toEqual(["claim", "artifact"]);
		expect(events.at(-1)).toBe("release");

		events.length = 0;
		await expect(
			lifecycle.withServices(["db"], { verbose: false, wait: false }, () =>
				Promise.reject(new Error("tests failed")),
			),
		).rejects.toThrow("tests failed");
		expect(events.at(-1)).toBe("release");
	});

	it("tears the services down instead with after: stop", async () => {
		const { ctx, events, lifecycle } = fixture();
		ctx.runtime.down = async () => {
			events.push("down");
		};
		await lifecycle.withServices(
			["db"],
			{
				verbose: false,
				wait: false,
				watchdog: false,
				after: { stop: { removeVolumes: true } },
			},
			async () => {},
		);
		expect(events.slice(-3)).toEqual(["down", "retire", "release claim"]);
	});

	it("hands the command a forced seed's outcome, a failed one included, without asking seed.check", async () => {
		const { envVars, events, lifecycle } = fixture();
		envVars.resolveSecrets = async () => ({});
		// The fixture's seed command does not exist: it fails, and `ci` turns
		// that into its exit code rather than a thrown start.
		const outcome = await lifecycle.withServices(
			["db"],
			{
				prepare: "all",
				seed: "force",
				verbose: false,
				wait: false,
				watchdog: false,
			},
			async ({ seed }) => seed,
		);
		expect(outcome).toMatchObject({ status: "failed" });
		expect(events).not.toContain("seed check");
	});
});

describe("production or development, in CI", () => {
	async function withCi<T>(run: () => Promise<T>): Promise<T> {
		const previous = process.env.CI;
		process.env.CI = "1";
		try {
			return await run();
		} finally {
			if (previous === undefined) delete process.env.CI;
			else process.env.CI = previous;
		}
	}

	/** Which env (production or not) each process of a start was given. */
	function recordModes(fixtureValue: ReturnType<typeof fixture>): string[] {
		const modes: string[] = [];
		const { envVars } = fixtureValue;
		envVars.buildEnvVars = ((production?: boolean) => {
			modes.push(`containers:${!!production}`);
			return {};
		}) as typeof envVars.buildEnvVars;
		envVars.exec = (async (
			command: string | readonly string[],
			_options?: unknown,
			production?: boolean,
		) => {
			modes.push(`${String(command)}:${!!production}`);
			return { exitCode: 0, stdout: "", stderr: "" };
		}) as typeof envVars.exec;
		envVars.buildAppEnvVars = ((name: string, production?: boolean) => {
			modes.push(`${name}:${!!production}`);
			return {};
		}) as typeof envVars.buildAppEnvVars;
		return modes;
	}

	it("a start without servers prepares for development processes", async () => {
		const value = fixture();
		const modes = recordModes(value);
		await withCi(() =>
			value.lifecycle.start({
				startServers: false,
				wait: false,
				verbose: false,
				watchdog: false,
			}),
		);
		// The caller's own processes (the CLI's dev servers, `exec`) are
		// development: the containers and migrations must not be production.
		expect(modes).toContain("containers:false");
		expect(modes).toContain("migrate:false");
		expect(modes.some((mode) => mode.endsWith(":true"))).toBe(false);
	});

	it("a start that runs the servers is production throughout", async () => {
		const value = fixture();
		const modes = recordModes(value);
		await withCi(() =>
			value.lifecycle.start({ wait: false, verbose: false, watchdog: false }),
		);
		expect(modes).toContain("containers:true");
		expect(modes).toContain("migrate:true");
		expect(modes).toContain("web:true");
		expect(modes).not.toContain("migrate:false");
		expect(modes).not.toContain("web:false");
	});
});

it("rejects missing library app directories before starting containers", async () => {
	const { ctx, events, lifecycle } = fixture();
	ctx.apps.web = resolveApp({
		...ctx.apps.web,
		kind: "server",
		port: 3000,
		cwd: "missing-buncargo-directory",
	});
	await expect(lifecycle.start({ verbose: false })).rejects.toThrow(
		"apps.web.cwd",
	);
	expect(events).toEqual([]);
});

it("runs bootstrap before Prisma and supplies expanded selection", async () => {
	const { ctx, events, lifecycle } = fixture();
	ctx.config.hooks = {
		...ctx.config.hooks,
		beforeMigrations: async () => {
			events.push("bootstrap");
		},
	};
	await lifecycle.start({ startServers: false, wait: false, verbose: false });
	expect(events.indexOf("bootstrap")).toBeLessThan(
		events.indexOf("bunx --no-install prisma migrate deploy"),
	);
});
it("bootstrap failure prevents automatic and custom migrations", async () => {
	const { ctx, events, lifecycle } = fixture();
	ctx.config.hooks = {
		beforeMigrations: async () => {
			throw new Error("bootstrap failed");
		},
	};
	await expect(
		lifecycle.start({ startServers: false, wait: false, verbose: false }),
	).rejects.toThrow("bootstrap failed");
	expect(events).not.toContain("bunx --no-install prisma migrate deploy");
	expect(events).not.toContain("migrate");
});
it("containers-only does not invoke bootstrap", async () => {
	const { ctx, lifecycle } = fixture();
	ctx.config.hooks = {
		beforeMigrations: async () => {
			throw new Error("bootstrap invoked");
		},
	};
	await lifecycle.start({
		prepare: "containers",
		startServers: false,
		wait: false,
		verbose: false,
	});
});
it("starts services requiring preparation after migrations and seeds using one artifact", async () => {
	const { ctx, events, lifecycle } = fixture();
	ctx.services.sync = resolveService("sync", {
		port: 8080,
		afterPreparation: true,
	});
	ctx.apps.web = resolveApp({
		port: 3000,
		devCommand: false,
		requiredServices: ["db", "sync"],
	});
	ctx.runtime.up = async (request) => {
		events.push(`up:${request.serviceNames.join(",")}:${!!request.noDeps}`);
	};
	await lifecycle.start({ startServers: false, wait: false, verbose: false });
	expect(events.indexOf("up:db:false")).toBeLessThan(events.indexOf("migrate"));
	expect(events.indexOf("up:sync:true")).toBeGreaterThan(
		events.indexOf("seed check"),
	);
	expect(events.filter((event) => event === "artifact")).toHaveLength(1);
});

it("cancels a pending bootstrap before migrations can start", async () => {
	const { ctx, events, lifecycle } = fixture();
	const controller = new AbortController();
	ctx.config.hooks = {
		beforeMigrations: async () => {
			controller.abort(new Error("cancel bootstrap"));
			await new Promise(() => {});
		},
	};
	await expect(
		lifecycle.start({
			startServers: false,
			wait: false,
			verbose: false,
			signal: controller.signal,
		}),
	).rejects.toThrow("cancel bootstrap");
	expect(events).not.toContain("bunx --no-install prisma migrate deploy");
	expect(events).not.toContain("migrate");
});

it("onlyServices starts just those services, with no app selecting them", async () => {
	const { ctx, events, lifecycle } = fixture();
	ctx.services.cache = resolveService("cache", {
		port: 6379,
		healthCheck: false,
	});
	// No app requires cache; a services-only start selects it anyway.
	ctx.runtime.up = async (request) => {
		events.push(`up:${request.serviceNames.join(",")}`);
	};
	await lifecycle.start({
		onlyServices: ["cache"],
		prepare: "containers",
		startServers: false,
		wait: false,
		verbose: false,
	});
	expect(events).toContain("up:cache");
	expect(events).not.toContain("up:db");
});

it("starts selected scope fetches before container preparation and skips containers-only", async () => {
	const fake = startFakeInfisical();
	const home = process.env.HOME;
	const binary = process.env.BUNCARGO_INFISICAL_PATH;
	process.env.HOME = fake.home;
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	clearScopeSecretsCache();
	fake.projects.app = { secrets: { KEY: "app" } };
	fake.projects.preparation = { secrets: { KEY: "preparation" } };
	const { ctx, lifecycle } = fixture();
	ctx.config.secrets = { projectId: "preparation", siteUrl: fake.siteUrl };
	const web = ctx.apps.web;
	if (!web) throw new Error("fixture needs web");
	const appScope = { projectId: "app", siteUrl: fake.siteUrl };
	web.secrets = appScope;
	const runtimeStart = ctx.runtime.ensureRunning;
	try {
		await lifecycle.start({
			prepare: "containers",
			startServers: false,
			wait: false,
			verbose: false,
			watchdog: false,
		});
		expect(fake.cliCalls()).toEqual([]);
		ctx.runtime.ensureRunning = async () => {
			const deadline = Date.now() + 5000;
			while (fake.requests.length < 2 && Date.now() < deadline)
				await Bun.sleep(10);
			expect(fake.requests).toHaveLength(2);
		};
		await lifecycle.start({
			startServers: false,
			wait: false,
			verbose: false,
			watchdog: false,
		});
		await Promise.all(
			[ctx.config.secrets, appScope].map((scope) => {
				const resolved = resolveScope(scope, undefined);
				return resolved && loadScopeSecrets(resolved);
			}),
		);
		expect(fake.cliCalls()).toHaveLength(1);
	} finally {
		ctx.runtime.ensureRunning = runtimeStart;
		clearScopeSecretsCache();
		fake.stop();
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (binary === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = binary;
	}
});

it("stops on an expired Infisical session before the claim or any container", async () => {
	const fake = startFakeInfisical({ cliLogin: "prompt" });
	const home = process.env.HOME;
	const binary = process.env.BUNCARGO_INFISICAL_PATH;
	// A developer's machine: CI and an exported token only warn.
	const ambient = [...CI_ENV_VARS, "INFISICAL_TOKEN"].map(
		(name) => [name, process.env[name]] as const,
	);
	for (const [name] of ambient) delete process.env[name];
	process.env.HOME = fake.home;
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	clearScopeSecretsCache();
	const { ctx, events, lifecycle } = fixture();
	ctx.config.secrets = { projectId: "p1", siteUrl: fake.siteUrl };
	try {
		const failure = await lifecycle
			.start({ startServers: false, verbose: false, watchdog: false })
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(InfisicalLoginError);
		expect((failure as InfisicalLoginError).message).toContain(
			`infisical login --domain=${fake.siteUrl}`,
		);
		expect(events).not.toContain("claim");
		expect(events).not.toContain("runtime");
	} finally {
		for (const [name, value] of ambient)
			if (value !== undefined) process.env[name] = value;
		clearScopeSecretsCache();
		fake.stop();
		if (home === undefined) delete process.env.HOME;
		else process.env.HOME = home;
		if (binary === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = binary;
	}
});

it("keeps preparation services serial when seed.beforeApps opts into overlap", async () => {
	const { ctx, events, lifecycle } = fixture();
	const seed = ctx.config.seed;
	if (!seed) throw new Error("fixture needs seed");
	seed.beforeApps = false;
	ctx.services.sync = resolveService("sync", {
		port: 8080,
		afterPreparation: true,
	});
	ctx.apps.web = resolveApp({
		port: 3000,
		devCommand: false,
		requiredServices: ["db", "sync"],
	});
	ctx.runtime.up = async (request) => {
		events.push(`up:${request.serviceNames.join(",")}`);
	};
	ctx.logInfo = () => {};
	const log = console.log;
	const messages: string[] = [];
	console.log = (message) => messages.push(String(message));
	try {
		await lifecycle.start({
			startServers: false,
			wait: false,
			verbose: true,
			watchdog: false,
		});
		expect(events.indexOf("up:sync")).toBeGreaterThan(
			events.indexOf("seed check"),
		);
		expect(
			messages.filter((message) =>
				message.includes("selected services use afterPreparation"),
			),
		).toHaveLength(1);
	} finally {
		console.log = log;
	}
});
