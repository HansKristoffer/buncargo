import { expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogs } from "../../core/process/app-logs";
import { buildRunEntry, publishRun, retireRuns } from "../../core/run-registry";

const cli = join(import.meta.dir, "..", "bin.ts");

it("prints one app's errors from the latest run", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-logs-cmd-"));
	try {
		const old = new AppLogs(root, "older", new Date(Date.UTC(2026, 0, 1)));
		old.write("shopify", "Error: from the previous run");
		old.flush();
		const logs = new AppLogs(root, "newer");
		logs.write("shopify", "compiling");
		logs.write("shopify", "Error: extension build failed");
		logs.write("api", "GET / 200");
		logs.flush();

		const run = (...args: string[]) =>
			Bun.spawnSync(
				[process.execPath, cli, "logs", ...args, `--root=${root}`],
				{
					env: { ...process.env, NO_COLOR: "1" },
				},
			);
		const errors = run("shopify", "--errors").stdout.toString();
		expect(errors).toContain("Error: extension build failed");
		expect(errors).not.toContain("compiling");
		expect(errors).not.toContain("previous run");

		const all = Bun.stripANSI(run().stdout.toString());
		expect(all).toContain("shopify compiling");
		expect(all).toContain("api GET / 200");

		const missing = run("web");
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr.toString() + missing.stdout.toString()).toContain(
			'No log for "web"',
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps an error's structured block together, and skips a notice that says failed", async () => {
	const root = mkdtempSync(join(tmpdir(), "buncargo-logs-block-"));
	try {
		const logs = new AppLogs(root, "run");
		for (const line of [
			"[core] INFO: Failed to read crontab, cron is disabled",
			"[ERROR] job.completed {",
			"  name: 'sync',",
			'  error_type: "Error",',
			"}",
			"GET / 200",
		])
			logs.write("worker", line);
		logs.write("api", "listening");
		logs.flush();

		const result = Bun.spawnSync(
			[process.execPath, cli, "logs", "--errors", `--root=${root}`],
			{ env: { ...process.env, NO_COLOR: "1" } },
		);
		const printed = Bun.stripANSI(result.stdout.toString())
			.trimEnd()
			.split("\n")
			.map((line) => line.slice("00:00:00 ".length));
		expect(printed).toEqual([
			"worker [ERROR] job.completed {",
			"worker   name: 'sync',",
			'worker   error_type: "Error",',
			"worker }",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** A live run of `apps` in `root`, owned by this test process, with a log line each. */
async function liveRun(
	root: string,
	sessionId: string,
	apps: string[],
	at: Date,
) {
	await publishRun({
		...buildRunEntry({
			sessionId,
			projectPrefix: "logs",
			projectName: "logs-test",
			root,
			isWorktree: false,
		}),
		startedAt: at.toISOString(),
		apps: apps.map((name) => ({
			name,
			pid: process.pid,
			port: 0,
			url: "",
			loopbackUrl: "",
			status: "ready" as const,
		})),
	});
	const logs = new AppLogs(root, sessionId, at);
	for (const app of apps) logs.write(app, `${app} of ${sessionId}`);
	logs.flush();
}

// `dev --apps=api`, then `dev --apps=web` in the same checkout: `logs api`
// read only the newest directory, web's, and found no log for api.
it("reads the live run that runs the app, not the newest one", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-logs-two-")));
	const sessions = ["aaaaaaaa-api-run", "bbbbbbbb-web-run"];
	try {
		await liveRun(
			root,
			sessions[0] as string,
			["api"],
			new Date(Date.UTC(2026, 0, 1)),
		);
		await liveRun(
			root,
			sessions[1] as string,
			["web"],
			new Date(Date.UTC(2026, 0, 2)),
		);
		const run = (...args: string[]) =>
			Bun.spawnSync(
				[process.execPath, cli, "logs", ...args, `--root=${root}`],
				{
					env: { ...process.env, NO_COLOR: "1" },
				},
			);

		const api = run("api");
		expect(api.exitCode).toBe(0);
		expect(api.stdout.toString()).toContain("api of aaaaaaaa-api-run");
		expect(run("--run=aaaaaaaa-api-run").stdout.toString()).toContain(
			"api of aaaaaaaa-api-run",
		);
		expect(run().stdout.toString()).toContain("web of bbbbbbbb-web-run");
		expect(run("--run=cccccccc").exitCode).toBe(1);
	} finally {
		await retireRuns(sessions);
		rmSync(root, { recursive: true, force: true });
	}
});

it("ends -f once its run has ended", async () => {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "buncargo-logs-follow-")),
	);
	const sessionId = "dddddddd-follow";
	try {
		await liveRun(root, sessionId, ["api"], new Date());
		const follow = Bun.spawn(
			[process.execPath, cli, "logs", "api", "-f", `--root=${root}`],
			{ env: { ...process.env, NO_COLOR: "1" }, stdout: "pipe" },
		);
		const reader = follow.stdout.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain(
			"api of dddddddd-follow",
		);

		await retireRuns([sessionId]);
		expect(await follow.exited).toBe(0);
	} finally {
		await retireRuns([sessionId]);
		rmSync(root, { recursive: true, force: true });
	}
});
