import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDeadline } from "../deadline";
import { execAsync } from "./exec";

describe("execAsync", () => {
	it("passes argv literally without shell expansion", async () => {
		const result = await execAsync(
			[
				process.execPath,
				"-e",
				"console.log(process.argv[1])",
				"a b $(echo unsafe) `echo unsafe`",
			],
			process.cwd(),
			{},
		);
		expect(result.stdout.trim()).toBe("a b $(echo unsafe) `echo unsafe`");
	});

	it("stops a process that ignores TERM within the timeout and grace", async () => {
		const start = performance.now();
		await expect(
			execAsync(
				[
					process.execPath,
					"-e",
					"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
				],
				process.cwd(),
				{},
				{ timeoutMs: 150, killGraceMs: 100 },
			),
		).rejects.toThrow("timed out");
		expect(performance.now() - start).toBeLessThan(1800);
	});

	it("rejects missing executables without an unhandled error", async () => {
		await expect(
			execAsync(["/does-not-exist/buncargo"], process.cwd(), {}),
		).rejects.toThrow();
	});

	it("supports cancellation with throwOnError false", async () => {
		const controller = new AbortController();
		const command = execAsync(
			[process.execPath, "-e", "setInterval(() => {}, 1000)"],
			process.cwd(),
			{},
			{ signal: controller.signal, throwOnError: false, killGraceMs: 100 },
		);
		setTimeout(() => controller.abort(new Error("cancelled by test")), 100);
		const result = await command;
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("cancelled by test");
	});
});

it("deadline cancellation waits for command cleanup before rejecting", async () => {
	const root = await mkdtemp(join(tmpdir(), "buncargo-deadline-exec-"));
	const marker = join(root, "pid");
	try {
		await expect(
			withDeadline(
				(signal) =>
					execAsync(
						[
							process.execPath,
							"-e",
							`process.on('SIGTERM', () => {}); await Bun.write(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
						],
						root,
						{},
						{ signal, killGraceMs: 100 },
					),
				150,
			),
		).rejects.toThrow("timed out");
		const pid = Number(await Bun.file(marker).text());
		expect(() => process.kill(pid, 0)).toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
