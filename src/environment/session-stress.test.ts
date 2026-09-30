import { expect, it } from "bun:test";
import { resolve } from "node:path";

it("repeats library sessions in an isolated process without leaking resources", async () => {
	const root = resolve(import.meta.dir, "../..");
	const child = Bun.spawn(
		[
			process.execPath,
			"scripts/stress-library-sessions.ts",
			"--sessions=20",
			"--concurrency=4",
		],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
	const report = JSON.parse(stdout);
	expect(report.sessions).toBe(20);
	expect(report.uniqueSessions).toBe(24);
	expect(report.final.descriptors).toBe(report.baseline.descriptors);
	expect(report.heapGrowthMiB).toBeLessThan(24);
}, 30_000);
