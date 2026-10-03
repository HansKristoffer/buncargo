import { expect, it } from "bun:test";
import { applyIntegrations } from "../config/integrations";
import type { AnyDevEnvironment, IntegrationConfig } from "../types";
import { runPreflight } from "./preflight";

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
	const env = { root: "/x", preflight: config.preflight } as AnyDevEnvironment;

	await runPreflight(env, ["api"]);
	expect(ran).toEqual(["own"]);

	await expect(runPreflight(env, ["shop"])).rejects.toThrow(
		"Shop login is valid: session expired; run `shop login`",
	);
	expect(ran).toEqual(["own", "own", "shop:false"]);
});
