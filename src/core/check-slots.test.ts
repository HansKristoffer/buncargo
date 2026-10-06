import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHECK_SLOT_ENV,
	type CheckSlotHolder,
	withCheckSlot,
} from "./check-slots";

const dirs: string[] = [];

function slotDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-check-slots-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("withCheckSlot", () => {
	it("makes the check past the cap wait until a slot frees", async () => {
		const dir = slotDir();
		const options = { dir, slots: 2, env: {}, pollMs: 5 };
		const first = deferred();
		const second = deferred();
		const order: string[] = [];

		const holders = [
			withCheckSlot("one", () => first.promise, { ...options, env: {} }),
			withCheckSlot("two", () => second.promise, { ...options, env: {} }),
		];
		let waitedOn: CheckSlotHolder[] = [];
		const third = withCheckSlot(
			"three",
			async () => {
				order.push("three ran");
			},
			{
				...options,
				env: {},
				onWait: (current) => {
					waitedOn = current;
				},
			},
		);

		await Bun.sleep(30);
		expect(order).toEqual([]);
		expect(waitedOn.map((holder) => holder.label).sort()).toEqual([
			"one",
			"two",
		]);

		order.push("one released");
		first.resolve();
		await third;
		expect(order).toEqual(["one released", "three ran"]);

		second.resolve();
		await Promise.all(holders);
		expect(readdirSync(dir)).toEqual([]);
	});

	it("reclaims a slot whose holder died", async () => {
		const dir = slotDir();
		const dead = Bun.spawnSync(["true"]).pid;
		writeFileSync(
			join(dir, "0.lock"),
			JSON.stringify({
				pid: dead,
				cwd: "/gone",
				label: "typecheck",
				startedAt: 0,
			}),
		);

		let ran = false;
		await withCheckSlot(
			"next",
			async () => {
				ran = true;
			},
			{ dir, slots: 1, env: {}, pollMs: 5 },
		);

		expect(ran).toBe(true);
	});

	it("reclaims a lock left empty, as a full disk leaves it", async () => {
		const dir = slotDir();
		const lock = join(dir, "0.lock");
		writeFileSync(lock, "");
		const longAgo = new Date(Date.now() - 60_000);
		utimesSync(lock, longAgo, longAgo);

		let ran = false;
		await withCheckSlot(
			"next",
			async () => {
				ran = true;
			},
			{ dir, slots: 1, env: {}, pollMs: 5 },
		);

		expect(ran).toBe(true);
	});

	it("runs the check without a slot when none can be taken", async () => {
		const dir = slotDir();
		const notADirectory = join(dir, "file");
		writeFileSync(notADirectory, "");

		let ran = false;
		await withCheckSlot(
			"anyway",
			async () => {
				ran = true;
			},
			{ dir: join(notADirectory, "slots"), slots: 1, env: {} },
		);

		expect(ran).toBe(true);
	});

	it("tells children it holds a slot, so a nested check does not wait on it", async () => {
		const dir = slotDir();
		const env: NodeJS.ProcessEnv = {};

		await withCheckSlot(
			"outer",
			async () => {
				expect(env[CHECK_SLOT_ENV]).toBe(join(dir, "0.lock"));
				// The only slot is taken by the outer check; this must not block.
				await withCheckSlot("inner", async () => {}, { dir, slots: 1, env });
			},
			{ dir, slots: 1, env },
		);

		expect(env[CHECK_SLOT_ENV]).toBeUndefined();
		expect(existsSync(join(dir, "0.lock"))).toBe(false);
	});

	it("takes no slot in CI or when the cap is 0", async () => {
		const dir = slotDir();
		await withCheckSlot("ci", async () => {}, {
			dir,
			slots: 1,
			env: { CI: "true" },
		});
		await withCheckSlot("off", async () => {}, { dir, slots: 0, env: {} });

		expect(readdirSync(dir)).toEqual([]);
	});

	it("releases the slot when the check throws", async () => {
		const dir = slotDir();
		const failing = withCheckSlot(
			"boom",
			async () => {
				throw new Error("boom");
			},
			{ dir, slots: 1, env: {} },
		);

		await expect(failing).rejects.toThrow("boom");
		expect(readdirSync(dir)).toEqual([]);
	});
});
