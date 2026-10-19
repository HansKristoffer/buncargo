import { describe, expect, it } from "bun:test";
import {
	describeServiceCondition,
	observeServices,
	serviceChanges,
	watchServiceContainers,
} from "./service-watch";
import type { ServiceRuntimeState } from "./types";

describe("observeServices", () => {
	it("reads stopped, removed and unhealthy containers apart from running ones", () => {
		const states: ServiceRuntimeState[] = [
			{ service: "postgres", running: false, exitCode: 0 },
			{ service: "redis", running: true, healthy: false },
			{ service: "upstash", running: true },
		];
		expect(
			observeServices(["postgres", "redis", "upstash", "mailpit"], states),
		).toEqual(
			new Map([
				["postgres", { state: "stopped", exitCode: 0 }],
				["redis", { state: "unhealthy" }],
				["upstash", { state: "up" }],
				["mailpit", { state: "missing" }],
			]),
		);
	});

	it("cannot tell anything from an empty listing", () => {
		expect(observeServices(["postgres"], [])).toBeUndefined();
	});
});

describe("serviceChanges", () => {
	it("reports a transition once, and recovery as its own change", () => {
		const up = new Map([["postgres", { state: "up" as const }]]);
		const down = new Map([
			["postgres", { state: "stopped" as const, exitCode: 0 }],
		]);
		expect(serviceChanges(new Map(), up)).toEqual([]);
		const stopped = serviceChanges(up, down);
		expect(stopped).toEqual([
			{ service: "postgres", condition: { state: "stopped", exitCode: 0 } },
		]);
		expect(describeServiceCondition(stopped[0] as (typeof stopped)[0])).toBe(
			"postgres stopped (exit 0)",
		);
		expect(serviceChanges(down, down)).toEqual([]);
		expect(serviceChanges(down, up).map(describeServiceCondition)).toEqual([
			"postgres is running again",
		]);
	});
});

describe("watchServiceContainers", () => {
	it("calls back when a watched container stops", async () => {
		let running = true;
		const changes: string[] = [];
		const { promise, resolve } = Promise.withResolvers<void>();
		const stop = watchServiceContainers({
			runtime: {
				projectServiceStates: async () => {
					return [{ service: "postgres", running, exitCode: 0 }];
				},
			},
			projectName: "app",
			services: () => ["postgres"],
			intervalMs: 5,
			onChange: (next) => {
				changes.push(...next.map(describeServiceCondition));
				resolve();
			},
		});
		running = false;
		await promise;
		stop();
		expect(changes).toEqual(["postgres stopped (exit 0)"]);
	});
});
