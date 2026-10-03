import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLeases } from "../core/leases";
import { patchRun } from "../core/run-registry";
import { acquireAppLeases } from "./dev-leases";
import { publishCurrentRun, type RunSource } from "./run-publish";

let root: string;
let savedHome: string | undefined;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-dev-leases-"));
	savedHome = process.env.HOME;
	process.env.HOME = root;
});
afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(root, { recursive: true, force: true });
});

const apps = {
	web: { port: 3000, devCommand: "bun dev", exclusive: "fixture:exclusive" },
};
function source(sessionId: string): RunSource {
	return {
		sessionId,
		root,
		projectPrefix: "fixture",
		projectName: "fixture",
		isWorktree: false,
		ports: { web: 3000 },
		urls: {},
		loopbackUrls: {},
		publicUrls: {},
		hosts: null,
		services: {},
		containerRuntime: "docker",
		resolvePrimaryApp: () => "web",
	};
}

it.each(["starting", "identity-refused"])(
	"retains an exclusive lease when its holder is %s",
	async (state) => {
		const owner = source("owner");
		await acquireAppLeases(owner, apps, { takeover: false });
		await publishCurrentRun(owner, { apps, serviceNames: [] });
		if (state === "identity-refused") {
			// Deliberately mismatched: this test must never signal the test process.
			await patchRun(owner.sessionId, {
				apps: [
					{
						name: "web",
						status: "ready",
						pid: process.pid,
						processIdentity: "invalid-test-identity",
					},
				],
			});
		}
		await expect(
			acquireAppLeases(source("contender"), apps, { takeover: true }),
		).rejects.toThrow("Could not stop fixture:exclusive");
		expect((await readLeases()).map((lease) => lease.sessionId)).toEqual([
			"owner",
		]);
	},
);
