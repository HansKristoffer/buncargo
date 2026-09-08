import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import type { ContainerRuntimeAdapter } from "../container-runtime";
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
	const envVars = {
		getHookContext: () => ({}),
		buildEnvVars: () => ({}),
		buildAppEnvVarsMap: () => ({ web: {} }),
		exec: async (command: string) => {
			events.push(command);
			return { exitCode: 0, stdout: "", stderr: "" };
		},
	} as unknown as DevEnvVarsApi<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	return { events, ctx, lifecycle: createLifecycleApi(ctx, envVars) };
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
		expect(events).toEqual(["artifact", "runtime", "up"]);
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
	ctx.runtime.up = (request) => {
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
