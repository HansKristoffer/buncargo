import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunAlive, loadRuns } from "./run-registry";

/**
 * The `runs.json` schema contract, shared with the Swift app.
 *
 * `menubar/fixtures/runs.v1.json` is read by this test and by
 * `menubar/scripts/smoke-test.sh`, which runs the app's `--status` mode against
 * it. A field one side stops writing or starts requiring breaks a test on both,
 * rather than shipping an app that decodes nothing.
 */
const FIXTURE = join(
	import.meta.dir,
	"..",
	"..",
	"menubar",
	"fixtures",
	"runs.v1.json",
);

describe("runs.json v1 fixture", () => {
	it("decodes with every field the app relies on", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-fixture-"));
		const path = join(dir, "runs.json");
		try {
			copyFileSync(FIXTURE, path);
			const runs = await loadRuns(path, { strict: true });

			expect(runs).toHaveLength(2);
			const run = runs[0];
			expect(run?.projectPrefix).toBe("lullu");
			expect(run?.worktree).toBe("t3code-f003056f");
			expect(run?.branch).toBe("fix-login");
			expect(run?.primaryApp).toBe("platform");
			expect(run?.hosts).toEqual({ active: true, tld: "localhost" });
			expect(run?.cli.program).toBe("/bin/echo");

			// Every app state the UI renders differently.
			expect(run?.apps.map((app) => app.status)).toEqual([
				"ready",
				"starting",
				"reused",
				"ready",
			]);
			expect(run?.apps.find((app) => app.name === "jobs")?.kind).toBe("worker");
			expect(run?.apps.find((app) => app.name === "jobs")).not.toHaveProperty(
				"port",
			);
			expect(
				run?.services.find((service) => service.name === "init"),
			).not.toHaveProperty("port");
			// The attached app is the one the app must confirm before stopping.
			expect(run?.apps.find((app) => app.attached)?.name).toBe("api");
			// A reused app has no pid, so the app offers the port-owner path.
			expect(
				run?.apps.find((app) => app.name === "worker")?.pid,
			).toBeUndefined();
			expect(run?.apps[1]?.publicUrl).toContain("trycloudflare");
			// The Expo app is the one the app offers a simulator button for.
			expect(run?.apps[1]?.expo?.scheme).toBe("lullu");

			const postgres = run?.services.find(
				(service) => service.name === "postgres",
			);
			expect(postgres?.preset).toBe("postgres");
			expect(postgres?.tablePlusUrl).toContain("tLSMode=0");
			expect(postgres?.container?.runtime).toBe("docker");
			expect(
				run?.services.find((service) => service.name === "mailpit")?.status,
			).toBe("stopped");

			// A finished run whose containers are still held. It has to decode —
			// the sweep is the one reader that wants it — and it must never read
			// as live. `menubar/scripts/smoke-test.sh` asserts the Swift side
			// hides it too, which matters because `pid: 1` is always alive: only
			// `releasedAt` can hide this one.
			const released = runs[1];
			expect(released?.releasedAt).toBe("2026-09-03T09:30:00.000Z");
			expect(released?.idleTimeoutMs).toBe(180_000);
			expect(released?.services[0]?.container?.runtime).toBe("docker");
			expect(released && isRunAlive(released)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
