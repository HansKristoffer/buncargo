import { expect, it } from "bun:test";
import { applyIntegrations } from "../config/integrations";
import type { AnyDevEnvironment, IntegrationConfig } from "../types";
import { runLatePreflight, runPreflight } from "./preflight";

it("runs the config's then integrations' steps for the selected apps, and stops on a failure", async () => {
	const ran: string[] = [];
	const config = applyIntegrations({
		projectPrefix: "p",
		services: {},
		apps: {},
		preflight: [{ name: "own", run: () => void ran.push("own") }],
		integrations: [
			{
				name: "shop",
				preflight: [
					{
						name: "Shop login is valid",
						apps: ["shop"],
						run: ({ interactive }) => {
							ran.push(`shop:${interactive}`);
							throw new Error("session expired; run `shop login`");
						},
					},
				],
			},
		],
	} as IntegrationConfig);
	const env = { root: "/x" } as AnyDevEnvironment;

	await runPreflight(env, config.preflight, ["api"]);
	expect(ran).toEqual(["own"]);

	await expect(runPreflight(env, config.preflight, ["shop"])).rejects.toThrow(
		"Shop login is valid: session expired; run `shop login`",
	);
	expect(ran).toEqual(["own", "own", "shop:false"]);
});

it("runs only late preflight steps not already run at startup and reports whether any ran", async () => {
	const ran: string[] = [];
	const steps = [
		{ name: "global", run: () => void ran.push("global") },
		{
			name: "mobile-only",
			apps: ["mobile", "admin"],
			run: ({ interactive }: { interactive: boolean }) =>
				void ran.push(`mobile:${interactive}`),
		},
	];
	const env = { root: "/x" } as AnyDevEnvironment;

	expect(await runLatePreflight(env, steps, ["api"], ["web"])).toBe(false);
	expect(ran).toEqual([]);

	expect(await runLatePreflight(env, steps, ["mobile"], ["web"])).toBe(true);
	expect(ran).toEqual(["mobile:false"]);

	// Once `mobile` ran it, starting `admin` with `mobile` in `startedApps` skips it.
	expect(await runLatePreflight(env, steps, ["admin"], ["web", "mobile"])).toBe(
		false,
	);
	expect(ran).toEqual(["mobile:false"]);
});
