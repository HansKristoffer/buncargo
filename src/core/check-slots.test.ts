import { afterEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CheckSlotClock,
	type CheckSlotHolder,
	type CheckSlotOptions,
	type CheckSlotWait,
	checkSlotStatus,
	processCheckSlot,
	withCheckSlot,
} from "./check-slots";
import { CHECK_SLOT_ENV } from "./runtime-flags";

const dirs: string[] = [];

/** A `HOME` of the test's own, and the slot directory inside it. */
function slotHome(): { home: string; dir: string } {
	const home = mkdtempSync(join(tmpdir(), "buncargo-check-slots-"));
	dirs.push(home);
	return { home, dir: join(home, ".buncargo", "check-slots") };
}

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** Time that passes as fast as a waiting check sleeps on it. */
function fastClock(): CheckSlotClock {
	let now = 0;
	return {
		now: () => now,
		sleep: async (ms) => {
			now += ms;
			await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

/** One check's options: its own environment, capped at `slots`. */
function check(
	home: string,
	slots: number,
	overrides: Partial<CheckSlotOptions> = {},
): CheckSlotOptions {
	return {
		env: { HOME: home, BUNCARGO_CHECK_SLOTS: String(slots) },
		clock: fastClock(),
		onWait: () => {},
		...overrides,
	};
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("withCheckSlot", () => {
	it("makes the check past the cap wait until a slot frees", async () => {
		const { home, dir } = slotHome();
		const first = deferred();
		const second = deferred();
		const waiting = deferred();
		const order: string[] = [];

		const holders = [
			withCheckSlot("one", () => first.promise, check(home, 2)),
			withCheckSlot("two", () => second.promise, check(home, 2)),
		];
		let waitedOn: CheckSlotHolder[] = [];
		const third = withCheckSlot(
			"three",
			async () => {
				order.push("three ran");
			},
			check(home, 2, {
				onWait: (current) => {
					waitedOn = current.holders;
					waiting.resolve();
				},
			}),
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
		const { home, dir } = slotHome();
		const holder = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`const { processCheckSlot, withCheckSlot } = await import(${JSON.stringify(import.meta.resolve("./check-slots"))});
				await withCheckSlot("killed", async () => {
					console.log("held");
					await new Promise(() => {});
				}, {
					env: { HOME: ${JSON.stringify(home)}, BUNCARGO_CHECK_SLOTS: "1" },
					clock: processCheckSlot.clock,
					onWait: () => {},
				});`,
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
			const options = check(home, 1, {
				onWait: () => {
					waited = true;
				},
			});
			await withCheckSlot(
				"next",
				async () => {
					expect(options.env[CHECK_SLOT_ENV]).toBe(join(dir, "0.lock"));
				},
				options,
			);
			expect(waited).toBe(false);
		} finally {
			holder.kill("SIGKILL");
		}
	});

	it("takes a slot whose file names a live process that does not hold it", async () => {
		// A recycled pid, or this very process: the file is a note, not the lock.
		const { home, dir } = slotHome();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "0.lock"),
			JSON.stringify({
				pid: process.pid,
				cwd: "/gone",
				label: "typecheck",
				startedAt: 0,
			}),
		);
		const options = check(home, 1);

		await withCheckSlot(
			"next",
			async () => {
				expect(options.env[CHECK_SLOT_ENV]).toBe(join(dir, "0.lock"));
			},
			options,
		);
	});

	it("runs the check without a slot once its wait passes the deadline", async () => {
		const { home } = slotHome();
		const held = deferred();
		const holding = withCheckSlot("long", () => held.promise, check(home, 1));
		const options = check(home, 1);

		let ranWith: string | undefined = "not run";
		await withCheckSlot(
			"impatient",
			async () => {
				ranWith = options.env[CHECK_SLOT_ENV];
			},
			options,
		);

		expect(ranWith).toBeUndefined();
		held.resolve();
		await holding;
	});

	it("runs the check without a slot when none can be taken", async () => {
		const { home } = slotHome();
		const notADirectory = join(home, "file");
		writeFileSync(notADirectory, "");

		let ran = false;
		await withCheckSlot(
			"anyway",
			async () => {
				ran = true;
			},
			check(notADirectory, 1),
		);

		expect(ran).toBe(true);
	});

	it("tells children it holds a slot, so a nested check does not wait on it", async () => {
		const { home, dir } = slotHome();
		const options = check(home, 1);

		await withCheckSlot(
			"outer",
			async () => {
				expect(options.env[CHECK_SLOT_ENV]).toBe(join(dir, "0.lock"));
				// The only slot is taken by the outer check; this must not block.
				await withCheckSlot("inner", async () => {}, options);
			},
			options,
		);

		expect(options.env[CHECK_SLOT_ENV]).toBeUndefined();
		expect(existsSync(join(dir, "0.lock"))).toBe(false);
	});

	it("takes no slot in CI or when the cap is 0", async () => {
		const { home, dir } = slotHome();
		const ci = check(home, 1);
		ci.env.CI = "true";
		await withCheckSlot("ci", async () => {}, ci);
		await withCheckSlot("off", async () => {}, check(home, 0));

		expect(existsSync(dir)).toBe(false);
	});

	it("releases the slot when the check throws", async () => {
		const { home, dir } = slotHome();
		const failing = withCheckSlot(
			"boom",
			async () => {
				throw new Error("boom");
			},
			check(home, 1),
		);

		await expect(failing).rejects.toThrow("boom");
		expect(readdirSync(dir)).toEqual([]);
	});

	it("tells each waiting check its place in line, and repeats it while it waits", async () => {
		const { home, dir } = slotHome();
		const held = deferred();
		const holding = withCheckSlot("long", () => held.promise, check(home, 1));

		const firstWaits: CheckSlotWait[] = [];
		const secondWaits: CheckSlotWait[] = [];
		const firstWaiting = deferred();
		const secondRepeated = deferred();
		// On the wall clock: it must still be waiting when the second one repeats.
		const first = withCheckSlot("first", async () => {}, {
			...check(home, 1),
			clock: processCheckSlot.clock,
			onWait: (wait) => {
				firstWaits.push(wait);
				firstWaiting.resolve();
			},
		});
		await firstWaiting.promise;
		const second = withCheckSlot(
			"second",
			async () => {},
			check(home, 1, {
				onWait: (wait) => {
					secondWaits.push(wait);
					if (secondWaits.length === 2) secondRepeated.resolve();
				},
			}),
		);
		await secondRepeated.promise;

		expect(firstWaits[0]).toMatchObject({ position: 1, waiting: 1 });
		expect(secondWaits.slice(0, 2)).toMatchObject([
			{ position: 2, waiting: 2 },
			{ position: 2, waiting: 2 },
		]);
		expect(secondWaits[0]?.holders.map((holder) => holder.label)).toEqual([
			"long",
		]);
		expect(checkSlotStatus(check(home, 1).env)).toMatchObject({
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
		const { home, dir } = slotHome();
		mkdirSync(dir, { recursive: true });
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
			check(home, 2),
		);
		await running.promise;

		const status = checkSlotStatus(check(home, 2).env);
		expect(status.holders.map((holder) => holder.label)).toEqual(["typecheck"]);
		expect(status).toMatchObject({ capacity: 2, enabled: true, waiting: 0 });
		expect(checkSlotStatus({ ...check(home, 2).env, CI: "true" }).enabled).toBe(
			false,
		);

		held.resolve();
		await holding;
	});
});
