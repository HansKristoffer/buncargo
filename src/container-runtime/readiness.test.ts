import { describe, expect, it } from "bun:test";
import type { ServiceConfig } from "../types";
import {
	ensureServicesRunning,
	runtimeAnsweredReadiness,
	waitForService,
} from "./readiness";
import type {
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	ServiceDiagnosis,
	ServiceRuntimeState,
} from "./types";
import { isTerminalContainerState } from "./types";

/**
 * A runtime whose containers never become healthy, so every test here exercises
 * the failure path the diagnosis exists for.
 */
function stubRuntime(
	diagnosis: ServiceDiagnosis | undefined,
	onDiagnose?: () => void,
): ContainerRuntimeAdapter {
	return {
		name: "apple",
		displayName: "Apple container",
		isAvailable: () => true,
		ensureRunning: async () => {},
		up: () => {},
		down: () => {},
		areServicesRunning: async () => true,
		execInService: () => false,
		diagnoseService: () => {
			onDiagnose?.();
			return diagnosis;
		},
		list: () => [],
		stopByIds: () => {},
		findContainerOnPort: () => undefined,
		containerPortOwners: () => new Map(),
		projectServiceStates: () => [],
	};
}

const NEVER_READY: ServiceConfig = {
	port: 5432,
	healthCheck: async () => false,
};

describe("isTerminalContainerState", () => {
	it("recognizes both runtimes' words for a container that is gone", () => {
		expect(isTerminalContainerState("exited")).toBe(true);
		expect(isTerminalContainerState("stopped")).toBe(true);
		expect(isTerminalContainerState("Dead")).toBe(true);
	});

	it("keeps polling for a state that has not been seen before", () => {
		// The safe direction: an unfamiliar state must not abort a startup that
		// would have succeeded.
		expect(isTerminalContainerState("running")).toBe(false);
		expect(isTerminalContainerState("created")).toBe(false);
		expect(isTerminalContainerState("initializing")).toBe(false);
	});
});

describe("waitForService failure reporting", () => {
	it("aborts as soon as the container is reported gone", async () => {
		const runtime = stubRuntime({
			state: "exited",
			exitCode: 1,
			logTail: "initdb: error: directory is not empty",
		});

		const startedAt = Date.now();
		const error = await waitForService("postgres", NEVER_READY, 5433, {
			runtime,
			projectName: "app-main",
			maxAttempts: 200,
			pollInterval: 5,
		}).catch((thrown: Error) => thrown);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("postgres");
		expect((error as Error).message).toContain("exited");
		expect((error as Error).message).toContain("exit code 1");
		expect((error as Error).message).toContain("directory is not empty");
		// 200 attempts would have been a full second; it gives up after ~8.
		expect(Date.now() - startedAt).toBeLessThan(400);
	});

	it("names the runtime, port and probe when it times out instead", async () => {
		const runtime = stubRuntime({ state: "running", logTail: "" });

		const error = await waitForService(
			"postgres",
			{ port: 5432, healthCheck: "tcp" },
			5433,
			{
				runtime,
				projectName: "app-main",
				maxAttempts: 3,
				pollInterval: 5,
			},
		).catch((thrown: Error) => thrown);

		const message = (error as Error).message;
		expect(message).toContain("Apple container");
		expect(message).toContain("5433");
		expect(message).toContain("tcp");
		expect(message).toContain("running");
	});

	it("still fails cleanly when the runtime cannot diagnose", async () => {
		const runtime = stubRuntime(undefined);

		const error = await waitForService("postgres", NEVER_READY, 5433, {
			runtime,
			projectName: "app-main",
			maxAttempts: 3,
			pollInterval: 5,
		}).catch((thrown: Error) => thrown);

		expect((error as Error).message).toContain("No container was found");
	});

	it("does not diagnose before giving the container a chance to appear", async () => {
		let calls = 0;
		const runtime = stubRuntime({ state: "exited", logTail: "" }, () => {
			calls++;
		});

		await waitForService("postgres", NEVER_READY, 5433, {
			runtime,
			projectName: "app-main",
			maxAttempts: 4,
			pollInterval: 5,
		}).catch(() => {});

		// Four attempts is under the interval, so only the timeout path asks.
		expect(calls).toBe(1);
	});
});

/**
 * `docker compose up` on an unchanged stack still costs most of a second, and
 * `bun dev` is run constantly. The stack hash is what makes skipping it safe:
 * it covers the interpolated definition of every selected service, so anything
 * that would change a container changes it too.
 */
describe("ensureServicesRunning reconcile", () => {
	function reconcileHarness(
		states: ServiceRuntimeState[] | ((hash: string) => ServiceRuntimeState[]),
	) {
		const ups: ContainerUpRequest[] = [];
		let seenHash = "";
		const runtime: ContainerRuntimeAdapter = {
			...stubRuntime(undefined),
			up: (request) => {
				ups.push(request);
			},
			projectServiceStates: () =>
				typeof states === "function" ? states(seenHash) : states,
		};

		async function run(): Promise<ContainerUpRequest[]> {
			await ensureServicesRunning({
				runtime,
				root: "/repo",
				projectName: "demo",
				envVars: { POSTGRES_PORT: "5532" },
				services: { postgres: { port: 5432, healthCheck: false } },
				ports: { postgres: 5532 },
				model: {
					name: "demo",
					services: {
						postgres: {
							image: "postgres:16",
							// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal `${...}` is what compose interpolates, and what this asserts.
							ports: ["${POSTGRES_PORT:-5432}:5432"],
						},
					},
				},
				verbose: false,
				wait: false,
			});
			return ups;
		}

		return {
			run,
			setSeenHash: (hash: string) => {
				seenHash = hash;
			},
		};
	}

	/** The hash a run produces, taken from the environment it passes to `up`. */
	async function hashFromRun(): Promise<string> {
		const harness = reconcileHarness([]);
		const ups = await harness.run();
		return ups[0]?.envVars.BUNCARGO_STACK_HASH ?? "";
	}

	it("reconciles when nothing is running", async () => {
		const harness = reconcileHarness([]);
		expect(await harness.run()).toHaveLength(1);
	});

	it("passes the stack hash to the backend so it lands as a label", async () => {
		expect(await hashFromRun()).toMatch(/^[0-9a-f]{16}$/);
	});

	it("skips the reconcile when the running stack already matches", async () => {
		const hash = await hashFromRun();
		const harness = reconcileHarness([
			{ service: "postgres", running: true, stackHash: hash },
		]);
		expect(await harness.run()).toHaveLength(0);
	});

	// The whole reason `up` used to run unconditionally: an edited image or
	// port has to take effect without a manual `--down`.
	it("reconciles when the running stack was created from other config", async () => {
		const harness = reconcileHarness([
			{ service: "postgres", running: true, stackHash: "0000000000000000" },
		]);
		expect(await harness.run()).toHaveLength(1);
	});

	// "Cannot compare" must mean reconcile, or an upgrade would leave a project
	// running yesterday's config forever.
	it("reconciles a container created before the label existed", async () => {
		const harness = reconcileHarness([{ service: "postgres", running: true }]);
		expect(await harness.run()).toHaveLength(1);
	});

	it("reconciles a matching container that is not running", async () => {
		const hash = await hashFromRun();
		const harness = reconcileHarness([
			{ service: "postgres", running: false, stackHash: hash },
		]);
		expect(await harness.run()).toHaveLength(1);
	});

	it("reconciles when the runtime cannot say what is running", async () => {
		const ups: ContainerUpRequest[] = [];
		const runtime: ContainerRuntimeAdapter = {
			...stubRuntime(undefined),
			up: (request) => ups.push(request),
			projectServiceStates: () => {
				throw new Error("daemon not answering");
			},
		};
		await ensureServicesRunning({
			runtime,
			root: "/repo",
			projectName: "demo",
			envVars: {},
			services: { postgres: { port: 5432, healthCheck: false } },
			ports: { postgres: 5532 },
			model: { name: "demo", services: { postgres: { image: "postgres:16" } } },
			verbose: false,
			wait: false,
		});
		expect(ups).toHaveLength(1);
	});
});

/**
 * A `docker compose exec pg_isready` costs seconds, and it is the same probe
 * the generated compose healthcheck already runs — so a runtime reporting the
 * container healthy has answered the question. The host-side probes cost
 * nothing and additionally prove the port is published, so they always run.
 */
describe("runtimeAnsweredReadiness", () => {
	it("accepts a healthy container for an in-container probe", () => {
		expect(
			runtimeAnsweredReadiness({ port: 5432, healthCheck: "pg_isready" }, true),
		).toBe(true);
		expect(
			runtimeAnsweredReadiness({ port: 6379, healthCheck: "redis-cli" }, true),
		).toBe(true);
	});

	it("still probes host-side checks, which prove the port is published", () => {
		expect(
			runtimeAnsweredReadiness({ port: 8025, healthCheck: "tcp" }, true),
		).toBe(false);
		expect(
			runtimeAnsweredReadiness({ port: 8123, healthCheck: "http" }, true),
		).toBe(false);
	});

	// The runtime's healthcheck is ours; a user's function is not, so a healthy
	// container says nothing about it.
	it("still runs a custom health check", () => {
		expect(
			runtimeAnsweredReadiness(
				{ port: 5432, healthCheck: async () => true },
				true,
			),
		).toBe(false);
	});

	it("only a positive report counts", () => {
		const config: ServiceConfig = { port: 5432, healthCheck: "pg_isready" };
		expect(runtimeAnsweredReadiness(config, false)).toBe(false);
		expect(runtimeAnsweredReadiness(config, undefined)).toBe(false);
	});
});
