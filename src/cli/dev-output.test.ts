import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApps } from "../config/resolve";
import { RunOutput, type StartReply } from "../core/process/run-output";
import * as prompt from "../core/prompt";
import { openDevOutput, restartReply } from "./dev-output";
import { RunTui } from "./tui/run-tui";

// An app's last screen reaches the feed only once `close()` has flushed it:
// the TUI unsubscribed first and lost it, where stream mode printed it.
it("closes the output before the TUI lets go of it", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-dev-output-"));
	const order: string[] = [];
	const interactive = spyOn(prompt, "isInteractive").mockReturnValue(true);
	// Not drawn: this test's terminal is not the TUI's to take.
	const start = spyOn(RunTui.prototype, "start").mockImplementation(() => {});
	const stop = spyOn(RunTui.prototype, "stop").mockImplementation(() => {
		order.push("tui stopped");
	});
	const close = spyOn(RunOutput.prototype, "close").mockImplementation(
		async () => {
			order.push("output closed");
		},
	);
	try {
		const view = await openDevOutput(
			{
				root,
				sessionId: "dev-output-test",
				urls: {},
				loopbackUrls: {},
				publicUrls: {},
			},
			resolveApps({ api: { port: 3000, devCommand: "bun run api" } }),
			{ tui: "on" },
		);
		expect(view.output.terminals).toBe("pty");
		view.start();
		await view.stop();
		expect(order).toEqual(["output closed", "tui stopped"]);
	} finally {
		interactive.mockRestore();
		start.mockRestore();
		stop.mockRestore();
		close.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});

// `buncargo restart` exited 0 whatever became of the request: a reused app
// the run could not replace, or a replacement that failed, read as success.
it("answers a restart request with what the supervisor made of it", async () => {
	const output = new RunOutput({ terminals: "pipe" });
	output.state("api", { state: "ready" });
	const outcomes: (() => Promise<boolean>)[] = [
		async () => true,
		async () => false,
		async () => {
			throw new Error("port 3000 is taken");
		},
	];
	output.controls = {
		restart: () => (outcomes.shift() ?? (async () => true))(),
	};
	expect(await restartReply(output, "api")).toEqual({ status: "began" });
	expect(await restartReply(output, "api")).toMatchObject({
		status: "not-ours",
	});
	expect(await restartReply(output, "api")).toEqual({
		status: "failed",
		reason: "port 3000 is taken",
	});
	expect(await restartReply(output, "web")).toMatchObject({
		status: "not-ours",
	});
});

it("answers a restart request for an app the run left out by starting it", async () => {
	const output = new RunOutput({ terminals: "pipe" });
	output.controls = { restart: async () => true };
	const leftOut = new Set(["mobile"]);

	// Not until the run's own apps are up and it binds the start: worth
	// asking again, so not a refusal.
	expect(await restartReply(output, "mobile", leftOut)).toMatchObject({
		status: "failed",
	});

	const replies: (() => Promise<StartReply>)[] = [
		async () => ({ status: "started", apps: ["metro", "mobile"] }),
		async () => ({ status: "refused", reason: "mobile needs redis" }),
		async () => {
			throw new Error("Required secrets are missing");
		},
	];
	output.startApp = async () => {
		const next = replies.shift();
		if (!next) throw new Error("asked more often than answered");
		return next();
	};

	expect(await restartReply(output, "mobile", leftOut)).toEqual({
		status: "started",
		apps: ["metro", "mobile"],
	});
	expect(await restartReply(output, "mobile", leftOut)).toEqual({
		status: "refused",
		reason: "mobile needs redis",
	});
	expect(await restartReply(output, "mobile", leftOut)).toEqual({
		status: "failed",
		reason: "Required secrets are missing",
	});
	// Not one it left out: as before.
	expect(await restartReply(output, "web", leftOut)).toMatchObject({
		status: "not-ours",
	});
});
