import { describe, expect, it } from "bun:test";
import { resolveService } from "../config/resolve";
import { serviceHashEnv } from "../docker-compose/interpolate";
import type { ComposeDocument } from "../types";
import { ensureServicesRunning } from "./ensure-services";
import { fakeRuntime, runtimeContainer } from "./fake-runtime.testing";
import type { ContainerUpRequest, RuntimeContainer } from "./types";

function harness() {
	const states = new Map<string, RuntimeContainer>();
	const requests: ContainerUpRequest[] = [];
	const runtime = fakeRuntime({
		containers: async () => [...states.values()],
		up: async (request: ContainerUpRequest) => {
			requests.push(request);
			for (const service of request.serviceNames) {
				const serviceHash = request.envVars[serviceHashEnv(service)];
				states.set(
					service,
					runtimeContainer({
						labels: {
							project: request.projectName,
							service,
							...(serviceHash ? { serviceHash } : {}),
						},
					}),
				);
			}
		},
	});
	return {
		requests,
		run: (
			model: ComposeDocument,
			selected: string[],
			envVars: Record<string, string> = {},
		) =>
			ensureServicesRunning({
				runtime,
				root: "/repo",
				projectName: "demo",
				projectPrefix: "demo",
				model,
				ports: {},
				envVars,
				services: Object.fromEntries(
					selected.map((name) => [
						name,
						resolveService(name, { port: 5432, healthCheck: false }),
					]),
				),
				wait: false,
				verbose: false,
			}),
	};
}

describe("warm per-service reconciliation", () => {
	it("retains shared service identity when selection expands or contracts", async () => {
		const { run, requests } = harness();
		const model = {
			services: { db: { image: "postgres:16" }, cache: { image: "redis:7" } },
		};
		await run(model, ["db"]);
		const dbHash = requests[0]?.envVars[serviceHashEnv("db")];
		expect(dbHash).toMatch(/^[a-f0-9]{16}$/);
		await run(model, ["db"]);
		expect(requests).toHaveLength(1);
		await run(model, ["db", "cache"]);
		expect(requests).toHaveLength(2);
		expect(requests[1]?.envVars[serviceHashEnv("db")]).toBe(dbHash);
		await run(model, ["cache"]);
		await run(model, ["db"]);
		expect(requests).toHaveLength(2);
	});
	it("reconciles changes to labels and effective environment", async () => {
		const { run, requests } = harness();
		const model = {
			services: {
				db: {
					image: "postgres:16",
					environment: { MODE: `\${MODE}` },
					labels: { team: "a" },
				},
			},
		};
		await run(model, ["db"], { MODE: "one" });
		await run(model, ["db"], { MODE: "two" });
		await run(
			{ services: { db: { ...model.services.db, labels: { team: "b" } } } },
			["db"],
			{ MODE: "two" },
		);
		expect(requests).toHaveLength(3);
	});
	it("reports a recreate of running containers as a start, and a reuse as none", async () => {
		const { run } = harness();
		const model = (tag: string) => ({
			services: { db: { image: `postgres:${tag}` } },
		});
		expect((await run(model("16"), ["db"])).started).toBe(true);
		expect((await run(model("16"), ["db"])).started).toBe(false);
		// Running, from another config: `up` recreates it.
		expect((await run(model("17"), ["db"])).started).toBe(true);
	});

	it("never claims an unknown dotenv or external build input is unchanged", async () => {
		for (const service of [
			{
				image: "postgres:16",
				environment: { MODE: `\${BUNCARGO_TEST_UNSET_EXTERNAL}` },
			},
			{ image: "postgres:16", env_file: "custom.env" },
			{ image: "postgres:16", build: "." },
		]) {
			const { run, requests } = harness();
			await run({ services: { db: service } }, ["db"]);
			await run({ services: { db: service } }, ["db"]);
			expect(requests).toHaveLength(2);
		}
	});
});
