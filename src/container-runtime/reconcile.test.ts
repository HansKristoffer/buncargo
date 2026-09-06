import { describe, expect, it } from "bun:test";
import { serviceHashEnv } from "../docker-compose/interpolate";
import type { ComposeDocument, ServiceConfig } from "../types";
import { ensureServicesRunning } from "./readiness";
import type {
	ContainerRuntimeAdapter,
	ContainerUpRequest,
	ServiceRuntimeState,
} from "./types";

function harness() {
	const states = new Map<string, ServiceRuntimeState>();
	const requests: ContainerUpRequest[] = [];
	const runtime = {
		name: "docker",
		displayName: "Docker",
		ensureRunning: async () => {},
		projectServiceStates: () => [...states.values()],
		up: (request: ContainerUpRequest) => {
			requests.push(request);
			for (const service of request.serviceNames)
				states.set(service, {
					service,
					running: true,
					serviceHash: request.envVars[serviceHashEnv(service)],
				});
		},
	} as unknown as ContainerRuntimeAdapter;
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
				model,
				ports: {},
				envVars,
				services: Object.fromEntries(
					selected.map((name) => [
						name,
						{ port: 5432, healthCheck: false } satisfies ServiceConfig,
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
