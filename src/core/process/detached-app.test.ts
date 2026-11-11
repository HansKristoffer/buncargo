import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { DetachedApp } from "./detached-app";

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
	const exited = Promise.withResolvers<number | null>();
	app.once("exit", (code: number | null) => exited.resolve(code));
	try {
		app.watch();
		const stillWatched = await Promise.race([
			exited.promise.then(() => false),
			Bun.sleep(1500).then(() => true),
		]);
		expect(stillWatched).toBe(true);

		process.kill(pid, "SIGKILL");
		expect(await exited.promise).toBe(0);
	} finally {
		app.dispose();
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			/* Already gone. */
		}
	}
});
