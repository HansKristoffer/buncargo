import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../config";
import { loadRuns } from "../core/run-registry";
import { buildComposeModel } from "../docker-compose";
import { service } from "../docker-compose/services";
import type { BuncargoIntegration, DevConfig } from "../types";
import { createDevEnvironment } from "./create-dev-environment";

const saved = {
	HOME: process.env.HOME,
	BUNCARGO_PORT_OFFSET: process.env.BUNCARGO_PORT_OFFSET,
	DOCKER_HOST: process.env.DOCKER_HOST,
};
let home = "";
let root = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-stacks-home-"));
	root = mkdtempSync(join(tmpdir(), "buncargo-stacks-"));
	writeFileSync(join(root, "package.json"), "{}");
	process.env.HOME = home;
	// No probing, and no daemon to reach should anything try.
	process.env.BUNCARGO_PORT_OFFSET = "100";
	process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

function fakeStack(log: string): BuncargoIntegration {
	return {
		name: "fake",
		stacks: {
			fake: {
				up: async (ctx) => {
					appendFileSync(log, `up ${ctx.selectedServices?.join(",")}\n`);
				},
				down: ({ projectName, removeVolumes }) => [
					"sh",
					"-c",
					`echo "down ${projectName} ${removeVolumes}" >> '${log}'`,
				],
			},
		},
	};
}

function stackConfig(log: string): DevConfig {
	return {
		projectPrefix: "stk",
		services: {
			api: { port: 4100, external: { stack: "fake" } },
			db: {
				port: 4101,
				external: { stack: "fake", preset: "postgres" },
				urlTemplate: ({ host, port }) => `postgresql://${host}:${port}/db`,
			},
		},
		integrations: [fakeStack(log)],
	};
}

describe("integration stacks", () => {
	it("starts the whole stack for one of its services, records it, and stops it", async () => {
		const log = join(root, "stack.log");
		const env = createDevEnvironment(stackConfig(log), { root });

		await env.start({
			onlyServices: ["api"],
			startServers: false,
			watchdog: false,
			verbose: false,
		});

		// Selecting one service selected its sibling: one CLI starts both.
		expect(readFileSync(log, "utf8")).toBe("up api,db\n");
		expect(env.ports.api).toBe(4200);
		// The stack's CLI owns its containers; nothing went through Compose.
		expect(
			existsSync(join(root, ".buncargo/docker-compose.generated.yml")),
		).toBe(false);

		const [run] = await loadRuns();
		expect(run?.services).toEqual([
			{ name: "api", status: "starting", stack: "fake" },
			{ name: "db", status: "starting", stack: "fake" },
		]);
		expect(run?.stacks).toEqual([
			{
				name: "fake",
				down: ["sh", "-c", `echo "down ${env.projectName} false" >> '${log}'`],
			},
		]);

		await env.stop({ removeVolumes: true, verbose: false });
		expect(readFileSync(log, "utf8")).toBe(
			`up api,db\ndown ${env.projectName} true\n`,
		);
		expect(await loadRuns()).toEqual([]);
	});

	it("leaves external services out of the Compose file", () => {
		const model = buildComposeModel({
			db: { port: 4101, external: { stack: "fake" } },
			cache: service.redis(),
		});
		expect(Object.keys(model.services)).toEqual(["cache"]);
	});

	it("rejects a service provided by a stack no integration defines", () => {
		const config = stackConfig(join(root, "unused.log"));
		expect(
			validateConfig({
				...config,
				services: {
					...config.services,
					typo: { port: 4102, external: { stack: "fakee" } },
				},
			}),
		).toContain(
			'Service "typo" is provided by stack "fakee", which no integration defines',
		);
	});
});
