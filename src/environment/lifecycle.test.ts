import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import type { ContainerRuntimeAdapter } from "../container-runtime";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import {
	clearScopeSecretsCache,
	loadScopeSecrets,
} from "../core/secrets/infisical";
import { planStart } from "../planning";
import type { AppConfig, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import { createLifecycleApi } from "./lifecycle";

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
	};
	return {
		events,
		ctx,
		lifecycle: createLifecycleApi(ctx, envVars, runClaim),
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
	it("an explicit stop retires the claim rather than holding it", async () => {
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
		await Promise.all([
			loadScopeSecrets(ctx.config.secrets),
			loadScopeSecrets(appScope),
		]);
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
