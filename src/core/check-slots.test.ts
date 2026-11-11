import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckSlotHolder,
	type CheckSlotWait,
	checkSlotStatus,
	withCheckSlot,
} from "./check-slots";
import { CHECK_SLOT_ENV } from "./runtime-flags";

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
		const waiting = deferred();
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
					waitedOn = current.holders;
					waiting.resolve();
				},
			},
		);

		await waiting.promise;
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

	it("frees the slot of a holder that was killed", async () => {
		const dir = slotDir();
		const holder = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`const { withCheckSlot } = await import(${JSON.stringify(import.meta.resolve("./check-slots"))});
				await withCheckSlot("killed", async () => {
					console.log("held");
					await new Promise(() => {});
				}, { dir: ${JSON.stringify(dir)}, slots: 1, env: {} });`,
			],
			{ stdout: "pipe", stderr: "inherit" },
		);
		try {
			const reader = holder.stdout.getReader();
			const { value } = await reader.read();
			expect(new TextDecoder().decode(value)).toContain("held");
			holder.kill("SIGKILL");
			await holder.exited;
			// Killed mid-check: its file is left behind, naming it.
			expect(readdirSync(dir)).toEqual(["0.lock"]);

			let waited = false;
			const env: NodeJS.ProcessEnv = {};
			await withCheckSlot(
				"next",
				async () => {
					expect(env[CHECK_SLOT_ENV]).toBe(join(dir, "0.lock"));
				},
				{
					dir,
					slots: 1,
					env,
					waitMs: 0,
					onWait: () => {
						waited = true;
					},
				},
			);
			expect(waited).toBe(false);
		} finally {
			holder.kill("SIGKILL");
		}
	});

	it("takes a slot whose file names a live process that does not hold it", async () => {
		// A recycled pid, or this very process: the file is a note, not the lock.
		const dir = slotDir();
		writeFileSync(
			join(dir, "0.lock"),
			JSON.stringify({
				pid: process.pid,
				cwd: "/gone",
				label: "typecheck",
				startedAt: 0,
			}),
		);
		const env: NodeJS.ProcessEnv = {};

		await withCheckSlot(
			"next",
			async () => {
				expect(env[CHECK_SLOT_ENV]).toBe(join(dir, "0.lock"));
			},
			{ dir, slots: 1, env, waitMs: 0 },
		);
	});

	it("runs the check without a slot once its wait passes the deadline", async () => {
		const dir = slotDir();
		const held = deferred();
		const holding = withCheckSlot("long", () => held.promise, {
			dir,
			slots: 1,
			env: {},
		});
		const env: NodeJS.ProcessEnv = {};

		let ranWith: string | undefined = "not run";
		await withCheckSlot(
			"impatient",
			async () => {
				ranWith = env[CHECK_SLOT_ENV];
			},
			{ dir, slots: 1, env, pollMs: 5, waitMs: 20 },
		);

		expect(ranWith).toBeUndefined();
		held.resolve();
		await holding;
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

	it("tells each waiting check its place in line, and repeats it while it waits", async () => {
		const dir = slotDir();
		const options = { dir, slots: 1, env: {}, pollMs: 5 };
		const held = deferred();
		const holding = withCheckSlot("long", () => held.promise, options);

		const firstWaits: CheckSlotWait[] = [];
		const secondWaits: CheckSlotWait[] = [];
		const firstWaiting = deferred();
		const secondRepeated = deferred();
		const first = withCheckSlot("first", async () => {}, {
			...options,
			env: {},
			onWait: (wait) => {
				firstWaits.push(wait);
				firstWaiting.resolve();
			},
		});
		await firstWaiting.promise;
		const second = withCheckSlot("second", async () => {}, {
			...options,
			env: {},
			repeatWaitMs: 10,
			onWait: (wait) => {
				secondWaits.push(wait);
				if (secondWaits.length === 2) secondRepeated.resolve();
			},
		});
		await secondRepeated.promise;

		expect(firstWaits[0]).toMatchObject({ position: 1, waiting: 1 });
		expect(secondWaits.slice(0, 2)).toMatchObject([
			{ position: 2, waiting: 2 },
			{ position: 2, waiting: 2 },
		]);
		expect(secondWaits[0]?.holders.map((holder) => holder.label)).toEqual([
			"long",
		]);
		expect(checkSlotStatus({ dir, slots: 1, env: {} })).toMatchObject({
			capacity: 1,
			enabled: true,
			waiting: 2,
		});

		held.resolve();
		await Promise.all([holding, first, second]);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe("checkSlotStatus", () => {
	it("lists only the holders whose lock is held, not a killed holder's file", async () => {
		const dir = slotDir();
		writeFileSync(
			join(dir, "1.lock"),
			JSON.stringify({ pid: 1, cwd: "/gone", label: "killed", startedAt: 0 }),
		);
		const held = deferred();
		const running = deferred();
		const holding = withCheckSlot(
			"typecheck",
			async () => {
				running.resolve();
				await held.promise;
			},
			{ dir, slots: 2, env: {} },
		);
		await running.promise;

		const status = checkSlotStatus({ dir, slots: 2, env: {} });
		expect(status.holders.map((holder) => holder.label)).toEqual(["typecheck"]);
		expect(status).toMatchObject({ capacity: 2, enabled: true, waiting: 0 });
		expect(
			checkSlotStatus({ dir, slots: 2, env: { CI: "true" } }).enabled,
		).toBe(false);

		held.resolve();
		await holding;
	});
});
