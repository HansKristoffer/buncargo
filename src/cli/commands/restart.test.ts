import { afterEach, beforeEach, expect, it } from "bun:test";
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
	type RestartReply,
	requestRestart,
	watchRestartRequests,
	withdrawRestartRequest,
} from "../restart-requests";
import { RESTART_EXIT, restartApps } from "./restart";

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
const DEV = { takenMs: 5_000, answerMs: 5_000 };
const NOBODY = { takenMs: 200, answerMs: 200 };
const request = () =>
	join(getProjectStateDir(root), "restart", "restart-session");
const apiRow = async () => (await loadRuns())[0]?.apps[0];
const restart = (names: string[], timeouts = DEV) =>
	restartApps({ root, session: undefined, names }, timeouts);

/** This test process answering as the `dev` run would. */
async function withRun(
	answer: (app: string) => RestartReply,
	use: () => Promise<void>,
): Promise<void> {
	const stop = watchRestartRequests(
		root,
		"restart-session",
		async (app) => answer(app),
		() => true,
	);
	try {
		await use();
	} finally {
		stop();
	}
}

it("exits 0 once the run answers that it replaced the app", async () => {
	await withRun(
		() => ({ status: "began" }),
		async () => {
			expect(await restart(["api"])).toBe(RESTART_EXIT.ok);
			expect(existsSync(request())).toBe(false);
		},
	);
});

// It exited 0 with a warning whatever the run made of the request.
it("exits 3 when the run refuses, and 1 when the replacement failed", async () => {
	const answers: RestartReply[] = [
		{ status: "not-ours", reason: "its process is not this run's" },
		{ status: "failed", reason: "port 7100 is taken" },
	];
	await withRun(
		() => answers.shift() ?? { status: "began" },
		async () => {
			expect(await restart(["api"])).toBe(RESTART_EXIT.refused);
			expect(await restart(["api"])).toBe(RESTART_EXIT.failed);
		},
	);
});

it("exits 2 for an app no run of the checkout started", async () => {
	expect(await restart(["nope"])).toBe(RESTART_EXIT.notFound);
});

it("exits 3 and withdraws the request when the run takes none, leaving its row alone", async () => {
	// A library `start()` records its apps' pids but reads no requests. The
	// command marked the row `starting` for good, so `wait --app` hung and
	// the menu bar showed the app starting.
	expect(await restart(["api"], NOBODY)).toBe(RESTART_EXIT.refused);
	expect((await apiRow())?.status).toBe("ready");
	expect(existsSync(request())).toBe(false);
});

it("withdraws only its own request", () => {
	requestRestart(root, "restart-session", "web");
	const api = requestRestart(root, "restart-session", "api");
	withdrawRestartRequest(root, "restart-session", api);
	const left = readFileSync(request(), "utf8").trim().split("\n");
	expect(left.map((line) => JSON.parse(line).app)).toEqual(["web"]);
});
