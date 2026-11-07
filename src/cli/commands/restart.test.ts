import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildRunEntry,
	loadRuns,
	patchRun,
	publishRun,
} from "../../core/run-registry";
import { getProjectStateDir } from "../../core/state-paths";
import {
	requestRestart,
	watchRestartRequests,
	withdrawRestartRequest,
} from "../restart-requests";
import { handleRestart, restartBegan } from "./restart";

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

// The run polls twice a second; a run that takes nothing is waited out quickly.
const DEV = { takenMs: 5_000, beganMs: 5_000 };
const NOBODY = { takenMs: 200, beganMs: 200 };
const request = () =>
	join(getProjectStateDir(root), "restart", "restart-session");
const apiRow = async () => (await loadRuns())[0]?.apps[0];

it("returns once the run shows the restart, so a wait that follows sees the new process", async () => {
	// `buncargo restart api && buncargo wait --app=api` returned at once on
	// the `ready` of the process the restart was about to replace.
	const stop = watchRestartRequests(
		root,
		"restart-session",
		// What `dev` does as it begins a restart (`onAppRestarting`).
		(app) => void patchRun("restart-session", { restarting: [app] }),
		() => true,
	);
	try {
		expect(await handleRestart(["api", "--root", root], DEV)).toBe(0);
		expect((await apiRow())?.status).toBe("starting");
		expect(existsSync(request())).toBe(false);
	} finally {
		stop();
	}
});

it("exits 3 and withdraws the request when the run takes none, leaving its row alone", async () => {
	// A library `start()` records its apps' pids but reads no requests. The
	// command marked the row `starting` for good, so `wait --app` hung and
	// the menu bar showed the app starting.
	expect(await handleRestart(["api", "--root", root], NOBODY)).toBe(3);
	expect((await apiRow())?.status).toBe("ready");
	expect(existsSync(request())).toBe(false);
});

it("withdraws only its own request", () => {
	requestRestart(root, "restart-session", "web");
	requestRestart(root, "restart-session", "api");
	withdrawRestartRequest(root, "restart-session", "api");
	expect(readFileSync(request(), "utf8")).toBe("web\n");
});

describe("restartBegan", () => {
	const row = { name: "api", pid: 10, status: "ready" as const };
	it("reads a new process or another state as begun, and the same row as not yet", () => {
		expect(restartBegan(row, row)).toBe(false);
		expect(restartBegan(row, { ...row, status: "starting" })).toBe(true);
		expect(restartBegan(row, { ...row, pid: 11 })).toBe(true);
		expect(restartBegan(row, undefined)).toBe(true);
	});
});
