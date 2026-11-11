import { beforeEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { FileLockTimeoutError, withFileLock } from "../file-lock";
import { writeJsonDocument } from "../registry-file";
import { buildRunEntry, publishRun } from "../run-registry";
import { stateFilePath } from "../state-paths";
import { useTempHome } from "../test-env.testing";
import { intentsPath } from "./coordinator-state";
import { leaveWhenIdle } from "./daemon";

const ORIGIN = "http://127.0.0.1:9";
const home = useTempHome();

beforeEach(async () => {
	// This test process stands in for the run that wants sharing, so it is live.
	await publishRun(
		buildRunEntry({
			sessionId: "late",
			projectPrefix: "demo",
			projectName: "demo",
			root: realpathSync(home()),
			isWorktree: false,
		}),
	);
});

const writeIntent = (origin = ORIGIN) =>
	writeJsonDocument(`${intentsPath()}/late.json`, {
		sessionId: "late",
		tokens: [],
		name: "test",
		origin,
		credential: "pub",
	});

test("an idle coordinator stays for a run that registered since its last refresh", async () => {
	await writeIntent();
	let marked = false;

	expect(
		await leaveWhenIdle(ORIGIN, async () => {
			marked = true;
		}),
	).toBe(false);
	expect(marked).toBe(false);
});

test("an idle coordinator marks itself leaving while it holds the launch lock", async () => {
	await writeIntent("http://127.0.0.1:10");
	let launcherBlocked = false;

	const left = await leaveWhenIdle(ORIGIN, async () => {
		await withFileLock(stateFilePath("connect-launch"), async () => {}, {
			timeoutMs: 0,
		}).catch((error) => {
			launcherBlocked = error instanceof FileLockTimeoutError;
		});
	});

	expect(left).toBe(true);
	expect(launcherBlocked).toBe(true);
});
