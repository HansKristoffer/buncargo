import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
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
import { useTempHome } from "../../core/test-env.testing";
import type { RestartJson } from "../json-documents";
import {
	type RestartReply,
	requestRestart,
	watchRestartRequests,
	withdrawRestartRequest,
} from "../restart-requests";
import { RESTART_EXIT, restartApps } from "./restart";

useTempHome();
let root: string;

beforeEach(async () => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-restart-root-")));
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

it("exits 2 for an app the run neither started nor left out", async () => {
	await withRun(
		(app) => ({
			status: "not-ours",
			reason: `this run started no app "${app}"`,
		}),
		async () => {
			expect(await restart(["nope"])).toBe(RESTART_EXIT.notFound);
		},
	);
});

it("exits 2 when no run of the checkout spawned apps", async () => {
	const elsewhere = realpathSync(
		mkdtempSync(join(tmpdir(), "buncargo-restart-other-")),
	);
	try {
		const exit = await restartApps(
			{ root: elsewhere, session: undefined, names: ["mobile"] },
			NOBODY,
		);
		expect(exit).toBe(RESTART_EXIT.notFound);
	} finally {
		rmSync(elsewhere, { recursive: true, force: true });
	}
});

it("asks the run to start an app it left out: 0 once the start began, 3 when it refuses", async () => {
	const asked: string[] = [];
	const answers: RestartReply[] = [
		{ status: "started", apps: ["api-worker", "mobile"] },
		{
			status: "refused",
			reason:
				"mobile needs redis, which this run did not start.\nEnd the run and start it with them.",
		},
	];
	await withRun(
		(app) => {
			asked.push(app);
			return answers.shift() ?? { status: "began" };
		},
		async () => {
			expect(await restart(["mobile"])).toBe(RESTART_EXIT.ok);
			expect(await restart(["mobile"])).toBe(RESTART_EXIT.refused);
		},
	);
	expect(asked).toEqual(["mobile", "mobile"]);
});

it("prints one JSON document with each answer, stopping at the first that did not restart", async () => {
	const printed: string[] = [];
	const spy = spyOn(console, "log").mockImplementation((line) => {
		printed.push(String(line));
	});
	const answers: RestartReply[] = [
		{ status: "began" },
		{ status: "started", apps: ["metro", "mobile"] },
		{
			status: "refused",
			reason: "search needs redis.\nbuncargo dev --apps=api,search",
		},
	];
	try {
		await withRun(
			() => answers.shift() ?? { status: "began" },
			async () => {
				const exit = await restartApps(
					{
						root,
						session: undefined,
						names: ["api", "mobile", "search", "never-asked"],
						json: true,
					},
					DEV,
				);
				expect(exit).toBe(RESTART_EXIT.refused);
			},
		);
	} finally {
		spy.mockRestore();
	}

	expect(printed).toHaveLength(1);
	const document: RestartJson = JSON.parse(printed[0] ?? "");
	expect(document).toEqual({
		version: 1,
		exitCode: RESTART_EXIT.refused,
		results: [
			{
				app: "api",
				outcome: "restarted",
				message: "Restarted api.",
				hints: [],
			},
			{
				app: "mobile",
				outcome: "started",
				message: `Started metro, mobile in the run (pid ${process.pid}).`,
				hints: [],
				apps: ["metro", "mobile"],
			},
			{
				app: "search",
				outcome: "refused",
				message: "The run did not start search: search needs redis.",
				hints: ["buncargo dev --apps=api,search"],
			},
		],
	});
});

it("asks for --run when several runs of the checkout could start a left-out app", async () => {
	await publishRun({
		...buildRunEntry({
			sessionId: "second-session",
			projectPrefix: "shop",
			projectName: "shop",
			root,
			isWorktree: false,
		}),
		apps: [
			{
				name: "web",
				port: 7200,
				url: "http://localhost:7200",
				loopbackUrl: "http://localhost:7200",
				status: "starting",
			},
		],
	});
	await patchRun("second-session", {
		apps: [{ name: "web", pid: process.pid, status: "ready" }],
	});

	expect(await restart(["mobile"], NOBODY)).toBe(RESTART_EXIT.failed);
	expect(existsSync(request())).toBe(false);
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
