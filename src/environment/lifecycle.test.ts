import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import type { ContainerRuntimeAdapter } from "../container-runtime";
import { readRemovals } from "../core/removal-log";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import {
	clearScopeSecretsCache,
	loadScopeSecrets,
	resolveScope,
} from "../core/secrets/infisical";
import { isolateHome } from "../core/test-env.testing";
import { planStart } from "../planning";
import type { AppConfig, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import { createLifecycleApi } from "./lifecycle";
import { LifecycleCoordinator } from "./lifecycle-coordinator";
import { createServiceWatch } from "./service-watch";

// Starting and stopping take the project's lifecycle lock and record the
// removal under `~/.buncargo`: a home of the test's own, never the developer's.
isolateHome("buncargo-lifecycle-");

function fixture() {
	const events: string[] = [];
	const services = { db: { port: 5432, healthCheck: false } };
	const apps = {
		web: {
			port: 3000,
			requiredServices: ["db"],
			devCommand: "exit 0",
			healthEndpoint: false,
		},
	};
	const runtime = {
		name: "docker",
		displayName: "Docker",
		ensureRunning: async () => {
			events.push("runtime");
		},
		up: () => {
			events.push("up");
		},
		projectServiceStates: () => [],
		containerPortOwners: () => new Map(),
	} as unknown as ContainerRuntimeAdapter;
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
		ports: {},
		urls: {},
		loopbackUrls: {},
		ensureComposeFile: () => {
			events.push("artifact");
		},
		composeModel: () => ({ services: { db: { image: "postgres:16" } } }),
	} as unknown as DevEnvContext<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	ctx.getStartPlan = (onlyApps, onlyServices) =>
		planStart(ctx.apps, ctx.services, { onlyApps, onlyServices });
	ctx.prepareStartAsync = async () => {};
	ctx.releaseThrowawayClaim = async () => {};

	const envVars = {
		getHookContext: () => ({}),
		buildEnvVars: () => ({}),
		buildAppEnvVarsMap: () => ({ web: {} }),
		buildAppEnvVars: () => ({}),
		exec: async (command: string) => {
			events.push(command);
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	} as unknown as DevEnvVarsApi<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
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
		ensureWatchdog: async () => {
			events.push("watchdog");
		},
		claimApps: async (apps: Record<string, AppConfig>) => apps,
		appEvents: {},
		abandonApps: async () => {},
		releaseApps: async () => {},
	};
	return {
		events,
		ctx,
		envVars,
		lifecycle: createLifecycleApi(
			ctx,
			envVars,
			runClaim,
			new LifecycleCoordinator(),
			createServiceWatch(ctx, runClaim.sessionId),
		),
	};
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
			ctx.apps.site = {
				port: 3001,
				devCommand: "exit 0",
				healthEndpoint: false,
			};
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
		// The containers are gone, so there is nothing to hold them for.
		expect(events.slice(-2)).toEqual(["down", "retire"]);
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
	ctx.apps.web = {
		...ctx.apps.web,
		kind: "server",
		port: 3000,
		cwd: "missing-buncargo-directory",
	};
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
	ctx.services.sync = { port: 8080, afterPreparation: true };
	ctx.apps.web = {
		port: 3000,
		devCommand: false,
		requiredServices: ["db", "sync"],
	};
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
	ctx.services.cache = { port: 6379, healthCheck: false };
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

it("keeps preparation services serial when seed.beforeApps opts into overlap", async () => {
	const { ctx, events, lifecycle } = fixture();
	const seed = ctx.config.seed;
	if (!seed) throw new Error("fixture needs seed");
	seed.beforeApps = false;
	ctx.services.sync = { port: 8080, afterPreparation: true };
	ctx.apps.web = {
		port: 3000,
		devCommand: false,
		requiredServices: ["db", "sync"],
	};
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
