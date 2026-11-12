import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useTempHome } from "../core/test-env.testing";
import type { DevConfig } from "../types";
import { createDevEnvironment } from "./create-dev-environment";
import { internalsOf } from "./internals";

useTempHome("all");
const savedOffset = process.env.BUNCARGO_PORT_OFFSET;
let root = "";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-hook-selection-"));
	writeFileSync(join(root, "package.json"), "{}");
	// No probing: the apps never bind.
	process.env.BUNCARGO_PORT_OFFSET = "100";
});

afterAll(() => {
	if (savedOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
	else process.env.BUNCARGO_PORT_OFFSET = savedOffset;
	rmSync(root, { recursive: true, force: true });
});

function config(hooks: DevConfig["hooks"]): DevConfig {
	return {
		projectPrefix: "hooksel",
		services: {},
		apps: {
			api: { port: 4300, devCommand: "exit 0", healthEndpoint: false },
			web: { port: 4301, devCommand: "exit 0", healthEndpoint: false },
		},
		hooks,
		options: { verbose: false },
	};
}

it("tells beforeServers the selected apps, not every configured one", async () => {
	let selected: readonly string[] | undefined;
	const env = createDevEnvironment(
		config({
			beforeServers: async (ctx) => {
				selected = ctx.selectedApps;
				throw new Error("stop before spawning");
			},
		}),
		{ root },
	);

	await expect(
		env.start({ onlyApps: ["api"], verbose: false, watchdog: false }),
	).rejects.toThrow("stop before spawning");
	expect(selected).toEqual(["api"]);
});

it("tells onCapture the prepared selection", async () => {
	let selected: readonly string[] | undefined;
	const env = createDevEnvironment(
		config({
			onCapture: async (_capture, ctx) => {
				selected = ctx.selectedApps;
			},
		}),
		{ root },
	);

	await env.prepareStartAsync(["web"]);
	await internalsOf(env).recordCapture("web", {
		name: "token",
		value: "x",
		as: "value",
	});
	expect(selected).toEqual(["web"]);
});
