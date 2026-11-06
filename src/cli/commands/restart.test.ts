import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRunEntry,
	loadRuns,
	patchRun,
	publishRun,
} from "../../core/run-registry";
import { getProjectStateDir } from "../../core/state-paths";
import { handleRestart } from "./restart";

let home: string;
let root: string;
let savedHome: string | undefined;

beforeEach(async () => {
	home = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-restart-home-")));
	root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-restart-root-")));
	savedHome = process.env.HOME;
	process.env.HOME = home;
	// This test process stands in for the `dev` run, so the entry is live.
	await publishRun({
		...buildRunEntry({
			sessionId: "restart-session",
			projectPrefix: "shop",
			projectName: "shop",
			root,
			isWorktree: false,
		}),
		apps: [
			{
				name: "api",
				port: 7100,
				url: "http://localhost:7100",
				loopbackUrl: "http://localhost:7100",
				status: "starting",
			},
		],
	});
	await patchRun("restart-session", {
		apps: [{ name: "api", pid: process.pid, status: "ready" }],
	});
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
});

it("marks the app starting before it asks the run to restart it", async () => {
	// `buncargo restart api && buncargo wait --app=api` returned at once on
	// the `ready` of the process the restart was about to replace.
	expect(await handleRestart(["api", "--root", root])).toBe(0);

	const [run] = await loadRuns();
	expect(run?.apps[0]?.status).toBe("starting");
	const request = join(getProjectStateDir(root), "restart", "restart-session");
	expect(readFileSync(request, "utf8")).toBe("api\n");
});
