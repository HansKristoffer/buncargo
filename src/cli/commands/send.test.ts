import { afterAll, beforeAll, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunOutput } from "../../core/process/run-output";
import { buildRunEntry, publishRun } from "../../core/run-registry";
import { sendRefusal } from "../dev-output";
import { watchSendRequests } from "../restart-requests";
import { handleSend, SEND_EXIT } from "./send";

// The registry lives under HOME: the test's own, never the developer's.
let dir: string;
const realHome = process.env.HOME;

beforeAll(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-send-")));
	process.env.HOME = join(dir, "home");
});

afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(dir, { recursive: true, force: true });
});

// `send` exited 0 whatever became of the keys; an agent was told they were
// pressed when the app had no terminal to read them.
it("exits by what became of the keys", async () => {
	const root = join(dir, "checkout");
	mkdirSync(root);
	await publishRun({
		...buildRunEntry({
			sessionId: "send-run",
			projectPrefix: "send",
			projectName: "send",
			root,
			isWorktree: false,
		}),
		apps: [
			{ name: "expo", kind: "worker", pid: process.pid, status: "ready" },
			{ name: "api", kind: "worker", pid: process.pid, status: "ready" },
			{ name: "web", kind: "worker", pid: process.pid, status: "stopped" },
		],
	});
	// The run's side, as `dev` answers: only expo has a terminal.
	const output = new RunOutput();
	const typed: string[] = [];
	output.screen("expo").input = (text) => {
		typed.push(text);
	};
	const stop = watchSendRequests(root, "send-run", (app, text) => {
		const refusal = sendRefusal(output, app);
		if (refusal === undefined) output.screens.get(app)?.input(text);
		return refusal;
	});
	const send = (...args: string[]) =>
		handleSend([...args, `--root=${root}`], { replyTimeoutMs: 5_000 });
	try {
		expect(await send("expo", "i")).toBe(SEND_EXIT.ok);
		expect(typed).toEqual(["i"]);
		expect(await send("api", "i")).toBe(SEND_EXIT.refused);
		expect(await send("web", "i")).toBe(SEND_EXIT.refused);
		expect(await send("nope", "i")).toBe(SEND_EXIT.notFound);
		expect(typed).toEqual(["i"]);
	} finally {
		stop();
	}
});
