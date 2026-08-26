import { describe, expect, it } from "bun:test";
import type { ServiceConfig } from "../types";
import { waitForService } from "./readiness";
import type { ContainerRuntimeAdapter, ServiceDiagnosis } from "./types";
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
