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

	it("keeps a database's data when its config changes", async () => {
		const adapter = appleContainerRuntimeAdapter();
		await adapter.ensureRunning({ verbose: false });
		const modelWith = (password: string) =>
			buildComposeModel(
				{ postgres: { port: 55433, password, healthCheck: "pg_isready" } },
				undefined,
				{ projectName: PROJECT, root: process.cwd(), worktree: null },
				"apple",
			);
		const psql = (sql: string) =>
			adapter.execInService({
				projectName: PROJECT,
				serviceName: "postgres",
				command: ["psql", "-U", "postgres", "-tAc", sql],
				timeoutMs: 5000,
			});
		const ready = () =>
			until(() =>
				adapter.execInService({
					projectName: PROJECT,
					serviceName: "postgres",
					command: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
				}),
			);
		const up = (password: string) =>
			adapter.up({
				root: process.cwd(),
				projectName: PROJECT,
				envVars: {},
				model: modelWith(password),
				serviceNames: ["postgres"],
				verbose: false,
			});

		try {
			await up("first");
			await ready();
			expect(await psql("create table kept (id int)")).toBe(true);

			// A different password is a different config hash: a recreate.
			await up("second");
			await ready();
			expect(await psql("select * from kept")).toBe(true);
		} finally {
			await adapter.down({
				root: process.cwd(),
				projectName: PROJECT,
				model: modelWith("first"),
				removeVolumes: true,
				verbose: false,
			});
		}
	}, 180_000);

	it("does not report a tcp service ready before it listens", async () => {
		const adapter = appleContainerRuntimeAdapter();
		await adapter.ensureRunning({ verbose: false });
		const model = buildComposeModel(
			{
				late: {
					port: 59000,
					docker: {
						image: "busybox",
						ports: ["59000:9000"],
						command: ["sh", "-c", "sleep 3; exec nc -lk -p 9000"],
					},
				},
			},
			undefined,
			{ projectName: PROJECT, root: process.cwd(), worktree: null },
			"apple",
		);
		const probe = () =>
			adapter.probeServicePort?.({
				projectName: PROJECT,
				serviceName: "late",
				hostPort: 59000,
			}) ?? Promise.resolve(false);

		try {
			await adapter.up({
				root: process.cwd(),
				projectName: PROJECT,
				envVars: {},
				model,
				serviceNames: ["late"],
				verbose: false,
			});
			expect(await probe()).toBe(false);
			await until(probe);
		} finally {
			await adapter.down({
				root: process.cwd(),
				projectName: PROJECT,
				verbose: false,
			});
		}
	}, 60_000);
});

/** Poll until `check` passes, failing after `timeoutMs`. */
async function until(
	check: () => Promise<boolean>,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(250);
	}
	throw new Error(`condition not met within ${timeoutMs}ms`);
}
