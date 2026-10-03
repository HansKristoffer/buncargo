import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppLogs } from "../../core/process/app-logs";

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
