import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DevConfig } from "../types";
import { createDevEnvironment } from "./create-dev-environment";

const saved = {
	HOME: process.env.HOME,
	BUNCARGO_PORT_OFFSET: process.env.BUNCARGO_PORT_OFFSET,
};
let home = "";
let root = "";

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-hook-selection-home-"));
	root = mkdtempSync(join(tmpdir(), "buncargo-hook-selection-"));
	writeFileSync(join(root, "package.json"), "{}");
	process.env.HOME = home;
	// No probing: the apps never bind.
	process.env.BUNCARGO_PORT_OFFSET = "100";
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(home, { recursive: true, force: true });
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

	env.prepareStart?.(["web"]);
	await env.recordCapture?.("web", { name: "token", value: "x", as: "value" });
	expect(selected).toEqual(["web"]);
});
