import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "buncargo-bin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("bin on Windows", () => {
	it("stops before any command runs and points at WSL", () => {
		const preload = join(dir, "win32.ts");
		writeFileSync(
			preload,
			'Object.defineProperty(process, "platform", { value: "win32" });',
		);
		const result = Bun.spawnSync(
			[
				process.execPath,
				"--preload",
				preload,
				join(import.meta.dir, "bin.ts"),
				"status",
			],
			{ cwd: dir, env: { ...process.env, NO_COLOR: "1" } },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).toBe("");
		expect(result.stderr.toString()).toContain("run buncargo in WSL");
	});
});
