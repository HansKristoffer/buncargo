import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_STALE_MS, withFileLock } from "./file-lock";

const dirs: string[] = [];

function tempTarget(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-lock-"));
	dirs.push(dir);
	return join(dir, "state.json");
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("withFileLock", () => {
	it("returns the operation result and releases the lock", async () => {
		const target = tempTarget();
		const result = await withFileLock(target, async () => "done");
		expect(result).toBe("done");
		expect(existsSync(`${target}.lock`)).toBe(false);
	});

	it("releases the lock when the operation throws", async () => {
		const target = tempTarget();
		await expect(
			withFileLock(target, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(`${target}.lock`)).toBe(false);
	});

	it("serializes overlapping holders", async () => {
		const target = tempTarget();
		let active = 0;
		let maxActive = 0;

		await Promise.all(
			Array.from({ length: 6 }, () =>
				withFileLock(target, async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await new Promise((resolve) => setTimeout(resolve, 5));
					active -= 1;
				}),
			),
		);

		expect(maxActive).toBe(1);
	});

	it("evicts a lock whose owner process is gone", async () => {
		const target = tempTarget();
		// pid 2^22 is above the macOS/Linux maximum, so it can never be alive.
		writeFileSync(
			`${target}.lock`,
			JSON.stringify({ pid: 4_194_304, at: Date.now() }),
		);

		const result = await withFileLock(target, async () => "recovered");
		expect(result).toBe("recovered");
	});

	it("evicts a lock left behind by a holder that stopped progressing", async () => {
		const target = tempTarget();
		writeFileSync(
			`${target}.lock`,
			JSON.stringify({ pid: process.pid, at: Date.now() - LOCK_STALE_MS - 1 }),
		);

		const result = await withFileLock(target, async () => "recovered");
		expect(result).toBe("recovered");
	});
});
