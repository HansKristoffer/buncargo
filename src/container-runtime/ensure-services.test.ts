import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireLegacyProject } from "./ensure-services";
import type { ContainerRuntimeAdapter } from "./types";

let home: string;
let savedHome: string | undefined;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-legacy-"));
	savedHome = process.env.HOME;
	process.env.HOME = home;
});
afterEach(() => {
	process.env.HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
});

function runtime(running: boolean, downs: string[]): ContainerRuntimeAdapter {
	return {
		projectServiceStates: async () =>
			running ? [{ service: "postgres", running: true }] : [],
		down: async ({ projectName }: { projectName: string }) => {
			downs.push(projectName);
		},
	} as unknown as ContainerRuntimeAdapter;
}

it("takes down the containers under a checkout's old project name, once", async () => {
	const downs: string[] = [];
	await retireLegacyProject(runtime(true, downs), "gey-wt-wt", home, false);
	expect(downs).toEqual(["gey-wt-wt"]);

	await retireLegacyProject(runtime(false, downs), "gey-wt-wt", home, false);
	expect(downs).toEqual(["gey-wt-wt"]);
});
