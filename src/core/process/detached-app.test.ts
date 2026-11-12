import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { spawn } from "node:child_process";
import { DetachedApp } from "./detached-app";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// Watching read the process identity every second: one `ps` fork per second
// per adopted app on macOS. Liveness is `kill(pid, 0)`; the identity is only
// checked before a signal.
it("watches an adopted server by its pid alone, and reports its exit", async () => {
	const server = spawn(
		process.execPath,
		["-e", "setInterval(() => {}, 1000)"],
		{
			detached: true,
			stdio: "ignore",
		},
	);
	const pid = server.pid ?? 0;
	// An identity no process has: reading it would call the server gone.
	const app = new DetachedApp(pid, "not-this-process");
	const exits: (number | null)[] = [];
	app.on("exit", (code: number | null) => exits.push(code));
	try {
		app.watch();
		jest.advanceTimersByTime(3000);
		expect(exits).toEqual([]);

		process.kill(pid, "SIGKILL");
		await new Promise<void>((resolve) => server.once("exit", () => resolve()));
		jest.advanceTimersByTime(1000);
		expect(exits).toEqual([0]);
	} finally {
		app.dispose();
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* Already gone. */
		}
	}
});
