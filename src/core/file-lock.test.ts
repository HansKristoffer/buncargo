import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileLockTimeoutError, withFileLock } from "./file-lock";

const dirs: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
function tempTarget(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-lock-"));
	dirs.push(dir);
	return join(dir, "state.json");
}
function holder(target: string, body: string) {
	const child = Bun.spawn(
		[
			process.execPath,
			"--eval",
			`
		import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "file-lock.ts"))};
		await withFileLock(${JSON.stringify(target)}, async () => { ${body} }, { timeoutMs: 15000 });
	`,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	children.push(child);
	return child;
}
async function waitForFile(path: string) {
	const deadline = performance.now() + 5000;
	while (!existsSync(path)) {
		if (performance.now() >= deadline)
			throw new Error(`No child marker at ${path}`);
		await Bun.sleep(10);
	}
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("withFileLock", () => {
	it("returns results and keeps the same lock inode across releases", async () => {
		const target = tempTarget();
		expect(await withFileLock(target, async () => "done")).toBe("done");
		const inode = statSync(`${target}.lock.v2`).ino;
		expect(await withFileLock(target, async () => "again")).toBe("again");
		expect(statSync(`${target}.lock.v2`).ino).toBe(inode);
	});

	it("releases ownership when the operation throws", async () => {
		const target = tempTarget();
		await expect(
			withFileLock(target, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(await withFileLock(target, async () => "recovered")).toBe(
			"recovered",
		);
	});

	it("serializes overlapping holders in the same process", async () => {
		const target = tempTarget();
		let active = 0;
		let maxActive = 0;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				withFileLock(target, async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(5);
					active -= 1;
				}),
			),
		);
		expect(maxActive).toBe(1);
	});

	it("times out without running the operation or stealing a live lock", async () => {
		const target = tempTarget();
		let entered = false;
		await withFileLock(target, async () => {
			await expect(
				withFileLock(
					target,
					async () => {
						entered = true;
					},
					{ timeoutMs: 60 },
				),
			).rejects.toBeInstanceOf(FileLockTimeoutError);
			expect(entered).toBe(false);
		});
		expect(await withFileLock(target, async () => "released")).toBe("released");
	});

	it("never steals a process lock held beyond the old five and ten second limits", async () => {
		const target = tempTarget();
		const marker = `${target}.entered`;
		const child = holder(
			target,
			`await Bun.write(${JSON.stringify(marker)}, "ready"); await Bun.sleep(11000);`,
		);
		await waitForFile(marker);
		let entered = false;
		await expect(
			withFileLock(target, async () => {
				entered = true;
			}),
		).rejects.toBeInstanceOf(FileLockTimeoutError);
		await Bun.sleep(5100);
		await expect(
			withFileLock(
				target,
				async () => {
					entered = true;
				},
				{ timeoutMs: 60 },
			),
		).rejects.toBeInstanceOf(FileLockTimeoutError);
		expect(entered).toBe(false);
		expect(await child.exited).toBe(0);
		expect(await withFileLock(target, async () => "released")).toBe("released");
	}, 15000);

	it("the kernel releases a killed owner without deleting the lock inode", async () => {
		const target = tempTarget();
		const marker = `${target}.entered`;
		const child = holder(
			target,
			`await Bun.write(${JSON.stringify(marker)}, "ready"); await Bun.sleep(60000);`,
		);
		await waitForFile(marker);
		const inode = statSync(`${target}.lock.v2`).ino;
		child.kill("SIGKILL");
		await child.exited;
		expect(await withFileLock(target, async () => "recovered")).toBe(
			"recovered",
		);
		expect(statSync(`${target}.lock.v2`).ino).toBe(inode);
	});

	it("serializes simultaneous processes modifying the same snapshot", async () => {
		const target = tempTarget();
		writeFileSync(target, "0");
		const code = `const value = Number(await Bun.file(${JSON.stringify(target)}).text()); await Bun.sleep(30); await Bun.write(${JSON.stringify(target)}, String(value + 1));`;
		const processes = Array.from({ length: 8 }, () => holder(target, code));
		expect(await Promise.all(processes.map((child) => child.exited))).toEqual(
			Array(8).fill(0),
		);
		expect(readFileSync(target, "utf8")).toBe("8");
	});

	it("waits for a live legacy owner regardless of its age", async () => {
		const target = tempTarget();
		writeFileSync(
			`${target}.lock`,
			JSON.stringify({ pid: process.pid, at: 0 }),
		);
		await expect(
			withFileLock(target, async () => "unsafe", { timeoutMs: 60 }),
		).rejects.toBeInstanceOf(FileLockTimeoutError);
		expect(existsSync(`${target}.lock`)).toBe(true);
	});

	it("can proceed after a legacy owner died without unlinking its file", async () => {
		const target = tempTarget();
		writeFileSync(
			`${target}.lock`,
			JSON.stringify({ pid: 4_194_304, at: Date.now() }),
		);
		expect(await withFileLock(target, async () => "recovered")).toBe(
			"recovered",
		);
		expect(existsSync(`${target}.lock`)).toBe(true);
	});
});
