import { describe, expect, it } from "bun:test";
import { buildComposeModel } from "../docker-compose";
import { appleContainerRuntimeAdapter } from "./adapter";
import { createAppleContainerCli } from "./cli";
import { isAppleContainerSupported } from "./preflight";

/**
 * End-to-end against a real Apple `container` install.
 *
 * Opt-in: it needs macOS 26 on Apple silicon with the runtime installed and its
 * system service startable, which no CI runner has. Enable with
 * `BUNCARGO_TEST_APPLE_CONTAINER=1` (see `bun run test:integration-apple`).
 */
const ENABLED =
	process.env.BUNCARGO_TEST_APPLE_CONTAINER === "1" &&
	isAppleContainerSupported();

const PROJECT = "buncargo-itest";
const MODEL = buildComposeModel(
	{ redis: { port: 6399, healthCheck: "tcp" } },
	undefined,
	{ projectName: PROJECT, root: process.cwd(), worktree: null },
);

describe.skipIf(!ENABLED)("apple container runtime", () => {
	it("starts, reports and tears down a service", async () => {
		const adapter = appleContainerRuntimeAdapter({
			cli: createAppleContainerCli(),
		});
		await adapter.ensureRunning({ verbose: false });

		const request = {
			root: process.cwd(),
			projectName: PROJECT,
			envVars: {},
			model: MODEL,
			serviceNames: ["redis"],
			verbose: false,
		};

		const running = async () =>
			(await adapter.projectServiceStates(PROJECT))
				.filter((state) => state.running)
				.map((state) => state.service);
		try {
			await adapter.up(request);

			expect(await running()).toEqual(["redis"]);
			const containers = adapter
				.list()
				.filter((container) => container.project === PROJECT);
			expect(containers.map((container) => container.service)).toEqual([
				"redis",
			]);
			expect(
				await adapter.execInService({
					projectName: PROJECT,
					serviceName: "redis",
					command: ["redis-cli", "ping"],
				}),
			).toBe(true);
		} finally {
			await adapter.down({
				root: process.cwd(),
				projectName: PROJECT,
				model: MODEL,
				removeVolumes: true,
				verbose: false,
			});
		}

		expect(await running()).toEqual([]);
	}, 180_000);
});
