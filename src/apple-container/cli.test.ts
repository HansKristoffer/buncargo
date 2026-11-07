import { describe, expect, it } from "bun:test";
import { createAppleContainerCli } from "./cli";

/**
 * A real process past a short timeout, through the runner every Apple probe
 * uses: whether a status was cut off or answered decides whether a teardown
 * may report nothing to stop.
 */
const sleep = Bun.which("sleep");
if (!sleep) throw new Error("these tests need `sleep` on PATH");
const cli = createAppleContainerCli({ binary: sleep });

describe("the Apple container runner", () => {
	it("says a command it killed at the timeout timed out", async () => {
		const sync = cli.run(["5"], { timeoutMs: 100 });
		const async = await cli.runAsync(["5"], { timeoutMs: 100 });

		expect(sync).toMatchObject({ ok: false, timedOut: true });
		expect(async).toMatchObject({ ok: false, timedOut: true });
	});

	it("reads a command killed by a signal as cut off, not as an answer", () => {
		const shell = Bun.which("sh");
		if (!shell) throw new Error("this test needs `sh` on PATH");
		const killedItself = createAppleContainerCli({ binary: shell }).run([
			"-c",
			"kill -TERM $$",
		]);

		expect(killedItself).toMatchObject({ ok: false, timedOut: true });
	});

	it("does not say a command that answered in time timed out", async () => {
		const sync = cli.run(["not-a-duration"], { timeoutMs: 5000 });
		const async = await cli.runAsync(["not-a-duration"], { timeoutMs: 5000 });

		expect(sync.ok).toBe(false);
		expect(sync.timedOut).toBeFalsy();
		expect(async.ok).toBe(false);
		expect(async.timedOut).toBeFalsy();
	});
});
