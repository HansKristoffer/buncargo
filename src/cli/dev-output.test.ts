import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApps } from "../config/resolve";
import { RunOutput } from "../core/process/run-output";
import * as prompt from "../core/prompt";
import { openDevOutput } from "./dev-output";
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
		const view = openDevOutput(
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
