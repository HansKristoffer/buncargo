import { describe, expect, it } from "bun:test";
import { runtimeContainer } from "./fake-runtime.testing";
import {
	describeServiceCondition,
	observeServices,
	type ServiceCondition,
	serviceChanges,
	settleConditions,
	watchServiceContainers,
} from "./service-watch";
import type { RuntimeContainer, ServiceRuntimeState } from "./types";

describe("observeServices", () => {
	it("reads stopped, removed and unhealthy containers apart from running ones", () => {
		const states: ServiceRuntimeState[] = [
			{ service: "postgres", state: "stopped", running: false, exitCode: 0 },
			{ service: "redis", state: "running", running: true, healthy: false },
			{ service: "upstash", state: "running", running: true },
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

	it("reads an answered, empty listing as every container removed", () => {
		expect(observeServices(["postgres", "redis"], [])).toEqual(
			new Map([
				["postgres", { state: "missing" }],
				["redis", { state: "missing" }],
			]),
		);
	});

	it("says nothing of a container whose state the runtime did not say", () => {
		expect(
			observeServices(
				["postgres"],
				[{ service: "postgres", state: "unknown", running: false }],
			),
		).toEqual(new Map());
	});

	it("reads a restarting or paused container as serving nothing, and says why", () => {
		const states: ServiceRuntimeState[] = [
			{ service: "search", state: "restarting", running: false, exitCode: 1 },
			{ service: "mail", state: "paused", running: false },
		];
		const observed = observeServices(["search", "mail"], states);
		expect(
			[...observed].map(([service, condition]) =>
				describeServiceCondition({ service, condition }),
			),
		).toEqual(["search keeps restarting (exit 1)", "mail is paused"]);
	});
});

describe("settleConditions", () => {
	const up = { state: "up" } as const;
	const restarting = {
		state: "stopped",
		exitCode: 1,
		why: "restarting",
	} as const;
	const of = (condition: ServiceCondition) => new Map([["search", condition]]);

	it("does not call a crash loop running again on one poll between restarts", () => {
		const reported = of(restarting);
		expect(settleConditions(reported, of(restarting), of(up))).toEqual(
			reported,
		);
		expect(settleConditions(reported, of(up), of(up))).toEqual(of(up));
	});

	it("reports a plain stop recovering at once", () => {
		const stopped = of({ state: "stopped", exitCode: 0 });
		expect(settleConditions(stopped, stopped, of(up))).toEqual(of(up));
	});

	it("keeps what was reported for a service it could not observe", () => {
		expect(settleConditions(of(restarting), of(up), new Map())).toEqual(
			of(restarting),
		);
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
				containers: async () => [
					runtimeContainer({
						state: running ? "running" : "exited",
						exitCode: 0,
						labels: { project: "app", service: "postgres" },
					}),
				],
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

	it("reports every container removed, but nothing while the runtime cannot answer", async () => {
		const answers: (() => RuntimeContainer[])[] = [
			() => [
				runtimeContainer({ labels: { project: "app", service: "postgres" } }),
			],
			() => {
				throw new Error("Cannot connect to the Docker daemon");
			},
			() => [],
		];
		const changes: string[] = [];
		let polls = 0;
		const { promise, resolve } = Promise.withResolvers<void>();
		const stop = watchServiceContainers({
			runtime: {
				containers: async () => {
					const answer = answers[Math.min(polls++, answers.length - 1)];
					return answer();
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
		await promise;
		stop();
		expect(polls).toBeGreaterThanOrEqual(3);
		expect(changes).toEqual(["postgres's container was removed"]);
	});
});
