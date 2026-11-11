import { describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRunsPath, loadRuns, runLivenessAsync } from "./run-registry";

/**
 * The `runs.json` schema contract, shared with the Swift app.
 *
 * `menubar/fixtures/runs.v1.json` is read by this test and by
 * `menubar/scripts/smoke-test.sh`, which runs the app's `--status` mode against
 * it. A field one side stops writing or starts requiring breaks a test on both,
 * rather than shipping an app that decodes nothing.
 */
const FIXTURES = join(import.meta.dir, "..", "..", "menubar", "fixtures");
const FIXTURE = join(FIXTURES, "runs.v1.json");

describe("runs.json v1 fixture", () => {
	it("decodes with every field the app relies on", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-fixture-"));
		const realHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			mkdirSync(dirname(getRunsPath()), { recursive: true });
			// The fixture's pids are 1, which neither side reads as a run. This
			// process stands in for them, as the smoke test's shell does.
			const fixture = readFileSync(FIXTURE, "utf8").replaceAll(
				'"pid": 1,',
				`"pid": ${process.pid},`,
			);
			writeFileSync(getRunsPath(), fixture);
			const runs = await loadRuns({ strict: true });
			const alive = await runLivenessAsync(runs);

			expect(runs).toHaveLength(3);
			const run = runs[0];
			expect(run?.projectPrefix).toBe("lullu");
			expect(run?.worktree).toBe("t3code-f003056f");
			expect(run?.branch).toBe("fix-login");
			expect(run?.primaryApp).toBe("platform");
			expect(run?.hosts).toEqual({ active: true, tld: "localhost" });
			expect(run?.cli.program).toBe("/bin/echo");
			// Its pid is alive and it records no identity.
			expect(run && alive(run)).toBe(true);

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
			expect(run?.apps[1]?.openUrl).toBe(run?.apps[1]?.publicUrl);
			// The Expo app is the one the app offers a simulator button for.
			expect(run?.apps[1]?.expo?.scheme).toBe("lullu");
			// Integration rows and captures, and the lease an app holds.
			expect(run?.details?.[0]?.label).toBe("Shopify preview");
			expect(run?.captures?.appUrl).toBe("https://example.trycloudflare.com");
			expect(run?.apps[0]?.exclusive).toStartWith("shopify-app:");
			// `stop` waits this long for an app that saves data on its way out.
			expect(run?.apps.find((app) => app.name === "jobs")?.stopGraceMs).toBe(
				60_000,
			);
			// A detached run's idle limit, and a hold taken over from a run
			// whose containers it reused; the app ignores both.
			expect(run?.detached).toBe(true);
			expect(run?.idleLimitMs).toBe(7_200_000);
			expect(run?.inheritedIdleTimeoutMs).toBe(180_000);
			// Tasks get a run button; a description is optional.
			expect(run?.tasks).toEqual([
				{ name: "db:seed", description: "Seed the dev database" },
				{ name: "reindex" },
			]);

			const postgres = run?.services.find(
				(service) => service.name === "postgres",
			);
			expect(postgres?.preset).toBe("postgres");
			expect(postgres?.tablePlusUrl).toContain("tLSMode=0");
			expect(postgres?.container?.runtime).toBe("docker");
			const mailpit = run?.services.find(
				(service) => service.name === "mailpit",
			);
			expect(mailpit?.status).toBe("stopped");
			// What the run's service watch records; the app shows it as failed.
			expect(mailpit?.problem?.state).toBe("stopped");

			// A finished run whose containers are still held. It has to decode —
			// the sweep is the one reader that wants it — and it must never read
			// as live. `menubar/scripts/smoke-test.sh` asserts the Swift side
			// hides it too, which matters because its pid is alive: only
			// `releasedAt` can hide this one.
			const released = runs[1];
			expect(released?.releasedAt).toBe("2026-09-03T09:30:00.000Z");
			expect(released?.idleTimeoutMs).toBe(180_000);
			expect(released?.services[0]?.container?.runtime).toBe("docker");
			// What the sweep stops once the checkout's own CLI is gone.
			expect(released?.stacks?.[0]?.composeProject).toBe(
				"lullu-t3code-released",
			);
			expect(released && alive(released)).toBe(false);

			// A crashed run whose pid now belongs to another process (the stand-in,
			// alive): its recorded identity no longer matches. The smoke test
			// asserts the Swift side hides it as the CLI does, from the identity.
			const crashed = runs[2];
			expect(crashed?.processIdentity).toStartWith("v2:");
			expect(crashed?.ownerLostAt).toBe("2026-09-03T08:20:00.000Z");
			expect(crashed && alive(crashed)).toBe(false);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * `menubar/fixtures/runs.v1.lossy.json`, which the app's
 * `RunRegistryTests.swift` decodes too: entries a reader cannot read are
 * dropped one at a time, never the whole list.
 */
describe("runs.json v1 lossy fixture", () => {
	it("drops the entries it cannot read and keeps the rest", async () => {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-fixture-"));
		const realHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			mkdirSync(dirname(getRunsPath()), { recursive: true });
			writeFileSync(
				getRunsPath(),
				readFileSync(join(FIXTURES, "runs.v1.lossy.json"), "utf8"),
			);
			const runs = await loadRuns({ strict: true });

			// The app keeps `unknown-status-session` and shows its unknown
			// statuses as starting; the CLI drops an entry with a status it does
			// not know, as it drops one without `apps`.
			expect(runs.map((run) => run.sessionId)).toEqual([
				"first-valid-session",
				"last-valid-session",
			]);
		} finally {
			if (realHome === undefined) delete process.env.HOME;
			else process.env.HOME = realHome;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
