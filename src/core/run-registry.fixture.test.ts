import { describe, expect, it } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuns } from "./run-registry";

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

			expect(runs).toHaveLength(1);
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
			]);
			// The attached app is the one the app must confirm before stopping.
			expect(run?.apps.find((app) => app.attached)?.name).toBe("api");
			// A reused app has no pid, so the app offers the port-owner path.
			expect(
				run?.apps.find((app) => app.name === "worker")?.pid,
			).toBeUndefined();
			expect(run?.apps[1]?.publicUrl).toContain("trycloudflare");

			const postgres = run?.services.find(
				(service) => service.name === "postgres",
			);
			expect(postgres?.preset).toBe("postgres");
			expect(postgres?.tablePlusUrl).toContain("tLSMode=0");
			expect(postgres?.container?.runtime).toBe("docker");
			expect(
				run?.services.find((service) => service.name === "mailpit")?.status,
			).toBe("stopped");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
