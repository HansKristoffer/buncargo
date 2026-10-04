import { describe, expect, it } from "bun:test";
import { parseDockerHealth, parseDockerServiceStates } from "./status";

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
				running: true,
				serviceHash: "abc123",
				healthy: true,
			},
		]);
	});

	it("reports a stopped container as not running", () => {
		expect(
			parseDockerServiceStates(line("redis", "exited", "Exited (0)")),
		).toEqual([{ service: "redis", running: false }]);
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
