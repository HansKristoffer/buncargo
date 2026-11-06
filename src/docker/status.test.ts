import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	assertDockerRunning,
	parseDockerExitCode,
	parseDockerHealth,
	parseDockerServiceStates,
} from "./status";

describe("assertDockerRunning", () => {
	it("says once that Docker is not running, and what to do", () => {
		const missing = join(import.meta.dir, "no-such-docker-binary");
		expect(() => assertDockerRunning(missing)).toThrow(
			/^Docker is not running.*try again\.$/,
		);
	});

	it.skipIf(process.platform !== "linux")(
		"names the runtime behind docker rather than 'unknown'",
		() => {
			const missing = join(import.meta.dir, "no-such-docker-binary");
			expect(() => assertDockerRunning(missing)).toThrow(
				/^Docker is not running \(docker-engine\)\. Start the Docker service/,
			);
		},
	);
});

/**
 * The whole project's state from one `docker ps`, replacing a listing per
 * service and — where Docker has already run our healthcheck — an in-container
 * probe that costs seconds.
 */
describe("parseDockerServiceStates", () => {
	const line = (service: string, state: string, status: string, hash = "") =>
		[service, state, status, hash].join("\t");

	it("reads a running service and its service hash", () => {
		expect(
			parseDockerServiceStates(
				line("postgres", "running", "Up 3 minutes (healthy)", "abc123"),
			),
		).toEqual([
			{
				service: "postgres",
				state: "running",
				running: true,
				serviceHash: "abc123",
				healthy: true,
			},
		]);
	});

	it("reports a stopped container as not running, with its exit code", () => {
		expect(
			parseDockerServiceStates(
				line("redis", "exited", "Exited (137) 3 minutes ago"),
			),
		).toEqual([
			{ service: "redis", state: "stopped", running: false, exitCode: 137 },
		]);
	});

	it("reads a restarting container as not serving, with the exit code it restarts from", () => {
		expect(
			parseDockerServiceStates(
				line("search", "restarting", "Restarting (1) 2 seconds ago"),
			),
		).toEqual([
			{ service: "search", state: "restarting", running: false, exitCode: 1 },
		]);
	});

	it("skips a container with no buncargo.service label", () => {
		expect(
			parseDockerServiceStates(line("", "running", "Up 1 second")),
		).toEqual([]);
	});

	it("reads several services from one listing", () => {
		const states = parseDockerServiceStates(
			[
				line("postgres", "running", "Up 3 minutes (healthy)"),
				line("redis", "running", "Up 3 minutes"),
			].join("\n"),
		);
		expect(states.map((state) => state.service)).toEqual(["postgres", "redis"]);
	});

	it("survives empty output", () => {
		expect(parseDockerServiceStates("")).toEqual([]);
	});
});

describe("parseDockerExitCode", () => {
	it("reads the code of a stopped or restarting container, negative ones too", () => {
		expect(parseDockerExitCode("Exited (137) 3 minutes ago")).toBe(137);
		expect(parseDockerExitCode("exited (-1) 1 second ago")).toBe(-1);
		expect(parseDockerExitCode("Restarting (2) 1 second ago")).toBe(2);
		expect(parseDockerExitCode("Up 3 minutes")).toBeUndefined();
	});
});

describe("parseDockerHealth", () => {
	it("reads Docker's own healthcheck verdict", () => {
		expect(parseDockerHealth("Up 3 minutes (healthy)")).toBe(true);
		expect(parseDockerHealth("Up 3 minutes (unhealthy)")).toBe(false);
	});

	// The distinction that keeps a probe from being skipped wrongly: a
	// container with no healthcheck has not answered, which is not the same as
	// answering "no".
	it("says nothing about a container with no healthcheck", () => {
		expect(parseDockerHealth("Up 3 minutes")).toBeUndefined();
		expect(parseDockerHealth("")).toBeUndefined();
	});

	it("does not mistake a starting healthcheck for a passing one", () => {
		expect(
			parseDockerHealth("Up 2 seconds (health: starting)"),
		).toBeUndefined();
	});
});
