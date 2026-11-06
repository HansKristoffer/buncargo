import { expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRunEntry,
	findRunsByRoot,
	publishRun,
	retireRuns,
} from "../../core/run-registry";
import { handleRestart } from "./restart";

// `buncargo restart api && buncargo wait --app=api` answered at once from the
// old process's `ready`: the run picks the request up on its next poll.
it("marks the app starting before it returns", async () => {
	const root = await realpath(
		await mkdtemp(join(tmpdir(), "buncargo-restart-")),
	);
	try {
		await publishRun({
			...buildRunEntry({
				sessionId: "restart-test",
				projectPrefix: "stub",
				projectName: "stub-restart",
				root,
				isWorktree: false,
			}),
			apps: [
				{
					name: "api",
					pid: process.pid,
					port: 3000,
					url: "http://localhost:3000",
					loopbackUrl: "http://localhost:3000",
					status: "ready",
				},
			],
		});

		expect(await handleRestart(["api", `--root=${root}`])).toBe(0);

		const [run] = await findRunsByRoot(root);
		expect(run?.apps.find((app) => app.name === "api")?.status).toBe(
			"starting",
		);
		expect(existsSync(join(root, ".buncargo", "restart", "restart-test"))).toBe(
			true,
		);
	} finally {
		await retireRuns(["restart-test"]);
		await rm(root, { recursive: true, force: true });
	}
});
