import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import { startAppServers } from "./servers";

const vars = {
	getHookContext: (signal?: AbortSignal) => ({ signal }),
	buildAppEnvVarsMap: () => ({}),
} as unknown as DevEnvVarsApi<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

it("cancels an uncooperative beforeServers hook before spawning", async () => {
	const controller = new AbortController();
	let seen: AbortSignal | undefined;
	const ctx = {
		config: {
			hooks: {
				beforeServers: async (context: { signal?: AbortSignal }) => {
					seen = context.signal;
					controller.abort(new Error("cancel before hook"));
					return new Promise<void>(() => {});
				},
			},
		},
	} as unknown as DevEnvContext<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	await expect(
		startAppServers(ctx, vars, {
			apps: {},
			productionBuild: false,
			verbose: false,
			signal: controller.signal,
		}),
	).rejects.toThrow("cancel before hook");
	expect(seen?.aborted).toBe(true);
});

it("cleans up spawned servers when the afterServers hook fails", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-hook-failure-"));
	const marker = join(root, "pid");
	await Bun.write(
		join(root, "app.ts"),
		`await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
	);
	const apps = {
		app: { port: 1, devCommand: "bun app.ts", healthEndpoint: false as const },
	};
	const ctx = {
		root,
		ports: {},
		projectName: "test-hooks",
		config: {
			hooks: {
				afterServers: async () => {
					const deadline = performance.now() + 3000;
					while (
						!(await Bun.file(marker).exists()) &&
						performance.now() < deadline
					)
						await Bun.sleep(20);
					throw new Error("after hook failed");
				},
			},
		},
	} as unknown as DevEnvContext<
		Record<string, ServiceConfig>,
		Record<string, AppConfig>
	>;
	try {
		await expect(
			startAppServers(ctx, vars, {
				apps,
				productionBuild: false,
				verbose: false,
			}),
		).rejects.toThrow("after hook failed");
		const pid = Number(await Bun.file(marker).text());
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
