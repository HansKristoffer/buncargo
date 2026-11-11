import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApps } from "../config/resolve";
import type { ContainerRuntimeAdapter } from "../container-runtime";
import type { AppConfig, ResolvedApp, ServiceConfig } from "../types";
import type { DevEnvContext } from "./context";
import type { DevEnvVarsApi } from "./env-vars";
import {
	type AppPipelineDeps,
	createAppPipeline,
	type Prepared,
} from "./pipeline";
import { createServerHookRunner } from "./servers";

const vars = {
	getHookContext: (signal?: AbortSignal) => ({ signal }),
} as unknown as DevEnvVarsApi<
	Record<string, ServiceConfig>,
	Record<string, AppConfig>
>;

/** A pipeline over a context that holds only what the test sets: its hooks and checkout. */
function pipelineFor(
	ctx: DevEnvContext<Record<string, ServiceConfig>, Record<string, AppConfig>>,
	root = "/",
) {
	const deps: AppPipelineDeps = {
		root,
		ports: {},
		projectName: "test-hooks",
		unsetEnv: undefined,
		runtime: () => ({}) as ContainerRuntimeAdapter,
		appEnv: () => ({}),
		runHook: createServerHookRunner(ctx, vars),
		waitForHealth: async () => {},
		recordCapture: async () => [],
		renderGeneratedFiles: () => [],
		runSeed: async () => ({ status: "not-configured" }),
		claim: {
			claimApps: async (apps: Record<string, ResolvedApp>) => ({
				apps,
				skipped: [],
			}),
			appEvents: {},
			abandonApps: async () => {},
		},
		ensureWatchdog: () => {},
		ownedServerPids: {},
	};
	return createAppPipeline(deps);
}

function prepared(apps: Record<string, ResolvedApp>): Prepared {
	return {
		selection: { appNames: Object.keys(apps), requiredServiceKeys: [] },
		apps,
		hasServices: false,
		productionBuild: false,
		verbose: false,
		watchdog: false,
		seed: { kind: "none" },
	};
}

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
	const pipeline = pipelineFor(ctx);
	const claimed = await pipeline.claimApps(prepared(resolveApps({})));
	await expect(
		pipeline.spawn(claimed, { signal: controller.signal }),
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
	const apps = resolveApps({
		app: { port: 1, devCommand: "bun app.ts", healthEndpoint: false },
	});
	const ctx = {
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
		const pipeline = pipelineFor(ctx, root);
		const claimed = await pipeline.claimApps(prepared(apps));
		await expect(pipeline.spawn(claimed)).rejects.toThrow("after hook failed");
		const pid = Number(await Bun.file(marker).text());
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
