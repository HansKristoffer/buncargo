import { describe, expect, it } from "bun:test";
import { resolveService, resolveServices } from "../config/resolve";
import { serviceHashEnv } from "../docker-compose/interpolate";
import type { ServiceConfig } from "../types";
import { ensureServicesRunning } from "./ensure-services";
import {
	fakeAppleRuntime,
	fakeRuntime,
	runtimeContainer,
} from "./fake-runtime.testing";
import { createBuiltInHealthCheck } from "./health-checks";
import {
	pollServiceReadiness,
	readinessPlan,
	runtimeAnsweredReadiness,
	waitForService,
} from "./readiness";
import type {
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	ServiceDiagnosis,
	ServiceRuntimeState,
} from "./types";

/**
 * A runtime whose service container sits in one state and never becomes
 * healthy, so every test here exercises the failure path the diagnosis exists
 * for. `onList` sees each listing, `onLogs` each log fetch.
 */
function stubRuntime(
	service: string,
	diagnosis: ServiceDiagnosis | undefined,
	hooks: { onList?: () => void; onLogs?: () => void } = {},
): ContainerRuntimeAdapter {
	return fakeAppleRuntime({
		containers: async () => {
			hooks.onList?.();
			if (!diagnosis) return [];
			return [serviceContainer(service, diagnosis.state, diagnosis.exitCode)];
		},
		logs: async () => {
			hooks.onLogs?.();
			return diagnosis?.logTail ?? "";
		},
	});
}

/** A service's container in the project these tests wait on. */
function serviceContainer(service: string, state: string, exitCode?: number) {
	return runtimeContainer({
		state,
		...(exitCode === undefined ? {} : { exitCode }),
		labels: { project: "app-main", service },
	});
}

const NEVER_READY: ServiceConfig = {
	port: 5432,
	healthCheck: async () => false,
};

describe("waitForService failure reporting", () => {
	it("aborts as soon as the container is reported gone", async () => {
		const runtime = stubRuntime("postgres", {
			state: "exited",
			exitCode: 1,
			logTail: "initdb: error: directory is not empty",
		});

		const startedAt = Date.now();
		const error = await pollServiceReadiness(
			"postgres",
			resolveService("postgres", { ...NEVER_READY, healthTimeout: 1000 }),
			5433,
			{
				runtime,
				projectName: "app-main",
				pollInterval: 5,
			},
		).catch((thrown: Error) => thrown);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("postgres");
		expect((error as Error).message).toContain("exited");
		expect((error as Error).message).toContain("exit code 1");
		expect((error as Error).message).toContain("directory is not empty");
		// 200 attempts would have been a full second; it gives up after ~8.
		expect(Date.now() - startedAt).toBeLessThan(400);
	});

	it("fails a crash-looping service before its timeout, saying it keeps crashing", async () => {
		const runtime = stubRuntime("search", {
			state: "restarting",
			exitCode: 1,
			logTail: "typesense: bad api key",
		});

		const error = await pollServiceReadiness(
			"search",
			resolveService("search", { ...NEVER_READY, healthTimeout: 2000 }),
			8108,
			{
				runtime,
				projectName: "app-main",
				pollInterval: 1,
			},
		).catch((thrown: Error) => thrown);

		const message = (error as Error).message;
		expect(message).toContain("keeps crashing");
		expect(message).toContain("restarting");
		expect(message).toContain("exit code 1");
		expect(message).toContain("bad api key");
	});

	it("gives a service that restarted once the chance to come up", async () => {
		let listings = 0;
		let ready = false;
		const runtime = stubRuntime(
			"search",
			{ state: "restarting", logTail: "" },
			{
				onList: () => {
					listings++;
					ready = true;
				},
			},
		);

		await pollServiceReadiness(
			"search",
			resolveService("search", {
				port: 8108,
				healthCheck: async () => ready,
				healthTimeout: 2000,
			}),
			8108,
			{ runtime, projectName: "app-main", pollInterval: 1 },
		);

		expect(listings).toBe(1);
	});

	it("gives a service that restarted between runs the chance to come up", async () => {
		// An on-failure service waiting for its dependency: it exits, comes
		// back and runs a while, more than once, before it serves.
		const seen = ["restarting", "running", "restarting", "running"];
		let ready = false;
		const runtime = fakeAppleRuntime({
			containers: async () => {
				const state = seen.shift();
				if (state === undefined) {
					ready = true;
					return [serviceContainer("api", "running")];
				}
				return [serviceContainer("api", state, 1)];
			},
		});

		await pollServiceReadiness(
			"api",
			resolveService("api", {
				port: 8080,
				healthCheck: async () => ready,
				healthTimeout: 2000,
			}),
			8080,
			{ runtime, projectName: "app-main", pollInterval: 1 },
		);

		expect(seen).toEqual([]);
	});

	it("names the runtime, port and probe when it times out instead", async () => {
		const runtime = stubRuntime("postgres", { state: "running", logTail: "" });

		const error = await pollServiceReadiness(
			"postgres",
			resolveService("postgres", {
				port: 5432,
				healthCheck: "tcp",
				healthTimeout: 15,
			}),
			5433,
			{
				runtime,
				projectName: "app-main",
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
		const runtime = stubRuntime("postgres", undefined);

		const error = await pollServiceReadiness(
			"postgres",
			resolveService("postgres", { ...NEVER_READY, healthTimeout: 15 }),
			5433,
			{
				runtime,
				projectName: "app-main",
				pollInterval: 5,
			},
		).catch((thrown: Error) => thrown);

		expect((error as Error).message).toContain("No container was found");
	});

	it("does not diagnose before giving the container a chance to appear", async () => {
		let calls = 0;
		const runtime = stubRuntime(
			"postgres",
			{ state: "exited", logTail: "" },
			{
				onLogs: () => {
					calls++;
				},
			},
		);

		await pollServiceReadiness(
			"postgres",
			resolveService("postgres", { ...NEVER_READY, healthTimeout: 20 }),
			5433,
			{
				runtime,
				projectName: "app-main",
				pollInterval: 5,
			},
		).catch(() => {});

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
		const runtime = fakeAppleRuntime({
			up: async (request) => {
				ups.push(request);
			},
			containers: async () =>
				(typeof states === "function" ? states(seenHash) : states).map(
					(state) =>
						runtimeContainer({
							state: state.state,
							labels: {
								project: "demo",
								service: state.service,
								...(state.serviceHash
									? { serviceHash: state.serviceHash }
									: {}),
							},
						}),
				),
		});

		async function run(): Promise<ContainerUpRequest[]> {
			await ensureServicesRunning({
				runtime,
				root: "/repo",
				projectName: "demo",
				projectPrefix: "demo",
				envVars: { POSTGRES_PORT: "5532" },
				services: resolveServices({
					postgres: { port: 5432, healthCheck: false },
				}),
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
		return ups[0]?.envVars[serviceHashEnv("postgres")] ?? "";
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
			{
				service: "postgres",
				state: "running",
				serving: true,
				serviceHash: hash,
			},
		]);
		expect(await harness.run()).toHaveLength(0);
	});

	// The whole reason `up` used to run unconditionally: an edited image or
	// port has to take effect without a manual `--down`.
	it("reconciles when the running stack was created from other config", async () => {
		const harness = reconcileHarness([
			{
				service: "postgres",
				state: "running",
				serving: true,
				serviceHash: "0000000000000000",
			},
		]);
		expect(await harness.run()).toHaveLength(1);
	});

	// "Cannot compare" must mean reconcile, or an upgrade would leave a project
	// running yesterday's config forever.
	it("reconciles a container created before the label existed", async () => {
		const harness = reconcileHarness([
			{ service: "postgres", state: "running", serving: true },
		]);
		expect(await harness.run()).toHaveLength(1);
	});

	it("reconciles a matching container that is not running", async () => {
		const hash = await hashFromRun();
		const harness = reconcileHarness([
			{
				service: "postgres",
				state: "stopped",
				serving: false,
				serviceHash: hash,
			},
		]);
		expect(await harness.run()).toHaveLength(1);
	});

	it("reconciles when the runtime cannot say what is running", async () => {
		const ups: ContainerUpRequest[] = [];
		const runtime = fakeAppleRuntime({
			up: async (request) => {
				ups.push(request);
			},
			containers: async () => {
				throw new Error("daemon not answering");
			},
		});
		await ensureServicesRunning({
			runtime,
			root: "/repo",
			projectName: "demo",
			projectPrefix: "demo",
			envVars: {},
			services: resolveServices({
				postgres: { port: 5432, healthCheck: false },
			}),
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
			runtimeAnsweredReadiness(
				resolveService("svc", { port: 5432, healthCheck: "pg_isready" }),
				true,
			),
		).toBe(true);
		expect(
			runtimeAnsweredReadiness(
				resolveService("svc", { port: 6379, healthCheck: "redis-cli" }),
				true,
			),
		).toBe(true);
	});

	it("still probes host-side checks, which prove the port is published", () => {
		expect(
			runtimeAnsweredReadiness(
				resolveService("svc", { port: 8025, healthCheck: "tcp" }),
				true,
			),
		).toBe(false);
		expect(
			runtimeAnsweredReadiness(
				resolveService("svc", { port: 8123, healthCheck: "http" }),
				true,
			),
		).toBe(false);
	});

	// The runtime's healthcheck is ours; a user's function is not, so a healthy
	// container says nothing about it.
	it("still runs a custom health check", () => {
		expect(
			runtimeAnsweredReadiness(
				resolveService("svc", { port: 5432, healthCheck: async () => true }),
				true,
			),
		).toBe(false);
	});

	it("only a positive report counts", () => {
		const config = resolveService("svc", {
			port: 5432,
			healthCheck: "pg_isready",
		});
		expect(runtimeAnsweredReadiness(config, false)).toBe(false);
		expect(runtimeAnsweredReadiness(config, undefined)).toBe(false);
	});
});

describe("readinessPlan", () => {
	it("waits on the container itself when there is no port to probe", () => {
		expect(
			readinessPlan(
				resolveService("svc", { kind: "job", rerun: "always" }),
				undefined,
			).kind,
		).toBe("completion");
		expect(
			readinessPlan(resolveService("svc", { healthCheck: "tcp" }), undefined)
				.kind,
		).toBe("process");
	});

	it("skips the wait the runtime already answered, or nothing asks for", () => {
		const pg = resolveService("svc", { port: 5432, healthCheck: "pg_isready" });
		expect(readinessPlan(pg, 5432, true).kind).toBe("runtimeHealth");
		expect(readinessPlan(pg, 5432)).toEqual({
			kind: "probe",
			probe: "pg_isready",
			port: 5432,
		});
		expect(
			readinessPlan(resolveService("svc", { port: 80, healthCheck: false }), 80)
				.kind,
		).toBe("none");
	});
});

/**
 * A runtime with a listing whose service container moves through `states`,
 * one per listing, and counts the diagnoses: the only call that reads logs.
 */
function listingRuntime(states: { state: string; exitCode?: number }[]) {
	let diagnoses = 0;
	let listings = 0;
	const runtime = fakeAppleRuntime({
		logs: async () => {
			diagnoses++;
			return "FATAL: boom";
		},
		containers: async () => {
			listings++;
			const current = states.length > 1 ? states.shift() : states[0];
			if (!current) return [];
			return [
				runtimeContainer({
					state: current.state,
					...(current.exitCode === undefined
						? {}
						: { exitCode: current.exitCode }),
					labels: { project: "demo", service: "worker" },
				}),
			];
		},
	});
	return {
		runtime,
		diagnoses: () => diagnoses,
		listings: () => listings,
	};
}

describe("readiness logs", () => {
	it("reads a starting container from the listing without its logs", async () => {
		const { runtime, diagnoses, listings } = listingRuntime([
			{ state: "created" },
			{ state: "created" },
			{ state: "running" },
		]);
		await pollServiceReadiness(
			"worker",
			resolveService("worker", {}),
			undefined,
			{
				runtime,
				projectName: "demo",
				pollInterval: 1,
			},
		);
		expect(listings()).toBe(3);
		expect(diagnoses()).toBe(0);
	});

	it("fetches the logs once, when the container fails", async () => {
		const { runtime, diagnoses } = listingRuntime([
			{ state: "running" },
			{ state: "exited", exitCode: 3 },
		]);
		const error = await pollServiceReadiness(
			"worker",
			resolveService("worker", { kind: "job", rerun: "always" }),
			undefined,
			{ runtime, projectName: "demo", pollInterval: 1 },
		).catch((thrown: Error) => thrown);
		expect((error as Error).message).toContain("exit code 3");
		expect((error as Error).message).toContain("FATAL: boom");
		expect(diagnoses()).toBe(1);
	});
});

describe("service readiness deadlines", () => {
	it("bounds an uncooperative custom callback by elapsed time", async () => {
		let probeSignal: AbortSignal | undefined;
		const start = performance.now();
		await expect(
			waitForService(
				"db",
				resolveService("db", {
					port: 5432,
					healthTimeout: 80,
					healthCheck: async (_port, signal) => {
						probeSignal = signal;
						return new Promise<boolean>(() => {});
					},
				}),
				5432,
				{ runtime: stubRuntime("db", undefined), projectName: "test" },
			),
		).rejects.toThrow("did not become ready");
		expect(performance.now() - start).toBeLessThan(400);
		expect(probeSignal?.aborted).toBe(true);
	});

	it("includes time spent in slow probes in the total budget", async () => {
		const start = performance.now();
		await expect(
			pollServiceReadiness(
				"db",
				resolveService("db", {
					port: 5432,
					healthTimeout: 80,
					healthCheck: async () => {
						await new Promise((resolve) => setTimeout(resolve, 200));
						return false;
					},
				}),
				5432,
				{
					runtime: stubRuntime("db", undefined),
					projectName: "test",
					pollInterval: 20,
				},
			),
		).rejects.toThrow("did not become ready");
		expect(performance.now() - start).toBeLessThan(350);
	});
});

describe("runtime health overrides", () => {
	it("runs the configured probe when raw Compose overrides container health", () => {
		expect(
			runtimeAnsweredReadiness(
				resolveService("svc", {
					port: 5432,
					healthCheck: "pg_isready",
					docker: { healthcheck: { test: ["CMD", "true"] } },
				}),
				true,
			),
		).toBe(false);
		expect(
			runtimeAnsweredReadiness(
				resolveService("svc", {
					port: 5432,
					healthCheck: "pg_isready",
					docker: {
						kind: "preset",
						preset: "postgres",
						service: { healthcheck: { test: ["CMD", "true"] } },
					},
				}),
				true,
			),
		).toBe(false);
	});
});

describe("the tcp health check", () => {
	function listen() {
		return Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
	}

	/** A runtime that lists `api` at 127.0.0.1, its host port mapped to `target`. */
	function addressedRuntime(hostPort: number, target: number) {
		return fakeAppleRuntime({
			containers: async () => [
				runtimeContainer({
					ports: [hostPort],
					targetPorts: { [hostPort]: target },
					address: "127.0.0.1",
					labels: { project: "test", service: "api" },
				}),
			],
		});
	}

	it("connects to the container's own address where published ports cannot be trusted", async () => {
		// The host port accepts, as Apple's forwarder does, but nothing listens
		// on the container port behind it.
		const forwarder = listen();
		const closed = listen();
		const closedPort = closed.port;
		closed.stop(true);
		try {
			const check = createBuiltInHealthCheck("tcp", "api", {
				runtime: addressedRuntime(forwarder.port, closedPort),
				projectName: "test",
			});
			expect(await check(forwarder.port)).toBe(false);
		} finally {
			forwarder.stop(true);
		}
	});

	it("passes once the service listens behind the published port", async () => {
		const service = listen();
		try {
			const check = createBuiltInHealthCheck("tcp", "api", {
				runtime: addressedRuntime(1, service.port),
				projectName: "test",
			});
			expect(await check(1)).toBe(true);
		} finally {
			service.stop(true);
		}
	});

	it("connects to the host port where the runtime trusts it", async () => {
		const server = listen();
		try {
			const check = createBuiltInHealthCheck("tcp", "api", {
				runtime: fakeRuntime(),
				projectName: "test",
			});
			expect(await check(server.port)).toBe(true);
		} finally {
			server.stop(true);
		}
	});
});
