import { expect, it } from "bun:test";
import { validateConfig } from "../config";
import { buildComposeModel } from "../docker-compose";
import { buildStartPlan } from "../planning";
import type { ServiceConfig } from "../types";
import { ensureServicesRunning, waitForService } from "./readiness";
import type { ContainerRuntimeAdapter, ServiceDiagnosis } from "./types";

const job: ServiceConfig = {
	kind: "job",
	rerun: "always",
	healthTimeout: 200,
	docker: { image: "alpine:3.21.3", command: ["sh", "-c", "exit 0"] },
};

function runtime(states: ServiceDiagnosis[]): ContainerRuntimeAdapter {
	return {
		name: "docker",
		displayName: "Docker",
		diagnoseService: () => (states.length > 1 ? states.shift() : states[0]),
	} as unknown as ContainerRuntimeAdapter;
}

it("waits for successful completion, not merely a running job", async () => {
	const states = [
		{ state: "running", logTail: "" },
		{ state: "exited", exitCode: 0, logTail: "initialized" },
	];
	await waitForService("init", job, undefined, {
		runtime: runtime(states),
		projectName: "fixture",
		pollInterval: 1,
	});
	expect(states).toHaveLength(1);
	const model = buildComposeModel({ init: job });
	expect(model.services.init?.ports).toEqual([]);
	expect(model.services.init?.restart).toBe("no");
});

it("fails with job exit details and log output", async () => {
	await expect(
		waitForService("init", job, undefined, {
			runtime: runtime([
				{ state: "exited", exitCode: 7, logTail: "replica setup failed" },
			]),
			projectName: "fixture",
		}),
	).rejects.toThrow("replica setup failed");
});

it("a still-running job times out and cancellation interrupts polling", async () => {
	await expect(
		waitForService("init", { ...job, healthTimeout: 10 }, undefined, {
			runtime: runtime([{ state: "running", logTail: "" }]),
			projectName: "fixture",
			pollInterval: 1,
		}),
	).rejects.toThrow("did not become ready");
	await expect(
		waitForService("init", job, undefined, {
			runtime: runtime([]),
			projectName: "fixture",
			signal: AbortSignal.abort(new Error("cancelled")),
		}),
	).rejects.toThrow("cancelled");
});

it("rejects unsupported Apple completion before invoking its daemon", async () => {
	let mutated = false;
	const adapter = {
		name: "apple",
		ensureRunning: async () => {
			mutated = true;
		},
	} as unknown as ContainerRuntimeAdapter;
	await expect(
		ensureServicesRunning({
			runtime: adapter,
			root: "/tmp",
			projectName: "fixture",
			services: { init: job },
			ports: {},
			envVars: {},
			model: buildComposeModel({ init: job }),
		}),
	).rejects.toThrow("cannot verify finite job exit codes");
	expect(mutated).toBe(false);
});

it("rejects phase inversions and malformed worker/job endpoints before startup", () => {
	expect(() =>
		buildStartPlan(
			{ api: { port: 3000, devCommand: false, requiredServices: ["db"] } },
			{
				db: {
					port: 5432,
					docker: { image: "postgres:17", depends_on: ["sync"] },
				},
				sync: { port: 8080, afterPreparation: true },
			},
			undefined,
		),
	).toThrow("afterPreparation");
	for (const service of [
		{ ...job, port: 3000 },
		{ ...job, rerun: undefined },
		{ ...job, docker: { image: "alpine", restart: "always" } },
	])
		expect(
			validateConfig({ projectPrefix: "invalid", services: { init: service } })
				.length,
		).toBeGreaterThan(0);
	expect(
		validateConfig({
			projectPrefix: "worker",
			services: {},
			apps: { jobs: { kind: "worker", port: 3000, devCommand: "run" } },
		}).length,
	).toBeGreaterThan(0);
});

it("validates completion references and cycles even in unselected infrastructure", () => {
	for (const services of [
		{
			db: {
				docker: {
					image: "postgres",
					depends_on: { init: { condition: "service_completed_successfully" } },
				},
			},
			init: { docker: { image: "alpine" } },
		},
		{
			db: {
				docker: {
					image: "postgres",
					depends_on: { init: { condition: "service_healthy" } },
				},
			},
			init: job,
		},
		{
			db: { docker: { image: "postgres", depends_on: ["init"] } },
			init: { ...job, docker: { image: "alpine", depends_on: ["db"] } },
		},
		{
			db: {
				docker: {
					image: "postgres",
					depends_on: { missing: { condition: "service_started" } },
				},
			},
		},
		{ db: { docker: { image: "postgres", depends_on: 42 } } },
	]) {
		expect(
			validateConfig({
				projectPrefix: "fixture",
				services,
				apps: { marketing: { port: 3000, devCommand: false } },
			}).length,
		).toBeGreaterThan(0);
	}
});
