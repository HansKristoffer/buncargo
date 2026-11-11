import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	acquireLease,
	describeLeaseHolder,
	readLeases,
	releaseLeases,
	transferLease,
} from "./leases";
import { useTempHome } from "./test-env.testing";

const home = useTempHome();
/** Where the leases live, under this test's own `HOME`. */
let path: string;
beforeEach(() => {
	path = join(home(), ".buncargo", "leases.json");
	mkdirSync(join(home(), ".buncargo"));
});

const request = (sessionId: string) => ({
	key: "shopify-app:abc",
	sessionId,
	app: "shopify",
	projectName: "shop",
	root: "/repo",
	worktree: sessionId === "a" ? null : "feature",
	branch: "main",
});

describe("leases", () => {
	it("refuses a second session and names the holder", async () => {
		expect(await acquireLease(request("a"))).toEqual({ ok: true });
		// Taking your own again is a no-op, not a conflict.
		expect(await acquireLease(request("a"))).toEqual({ ok: true });

		const refused = await acquireLease(request("b"));
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.holder.sessionId).toBe("a");
		expect(describeLeaseHolder(refused.holder)).toBe(
			`shop (main checkout, main), app "shopify", pid ${process.pid}`,
		);
	});

	it("moves the lease on a takeover", async () => {
		await acquireLease(request("a"));
		const refused = await acquireLease(request("b"));
		if (refused.ok) throw new Error("Expected a lease conflict");
		expect(
			await transferLease(request("b"), refused.holder, async () => {
				// A stopped run can release its leases without waiting for the transfer.
				await releaseLeases("a");
				return true;
			}),
		).toEqual({
			ok: true,
		});
		expect((await readLeases()).map((lease) => lease.sessionId)).toEqual(["b"]);
	});

	it("allows only one takeover of the same observed holder", async () => {
		await acquireLease(request("a"));
		const refused = await acquireLease(request("b"));
		if (refused.ok) throw new Error("Expected a lease conflict");
		const stopped: string[] = [];
		const results = await Promise.all(
			["b", "c"].map((session) =>
				transferLease(request(session), refused.holder, async (holder) => {
					stopped.push(holder.sessionId);
					return true;
				}),
			),
		);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		expect(results.filter((result) => !result.ok)).toMatchObject([
			{ reason: "changed" },
		]);
		expect(stopped).toEqual(["a"]);
		const winner = ["b", "c"][results.findIndex((result) => result.ok)];
		expect((await readLeases()).map((entry) => entry.sessionId)).toEqual([
			winner,
		]);
	});

	it("keeps the lease when stopping its holder is refused", async () => {
		await acquireLease(request("a"));
		const refused = await acquireLease(request("b"));
		if (refused.ok) throw new Error("Expected a lease conflict");
		expect(
			await transferLease(request("b"), refused.holder, async () => false),
		).toMatchObject({ ok: false, reason: "stop-refused" });
		expect((await readLeases()).map((entry) => entry.sessionId)).toEqual(["a"]);
	});

	it("rechecks an intervening registry writer after stopping", async () => {
		await acquireLease(request("a"));
		const refused = await acquireLease(request("b"));
		if (refused.ok) throw new Error("Expected a lease conflict");
		const result = await transferLease(
			request("b"),
			refused.holder,
			async () => {
				writeFileSync(
					path,
					JSON.stringify({
						version: 1,
						leases: [{ ...refused.holder, sessionId: "c" }],
					}),
				);
				return true;
			},
		);
		expect(result).toMatchObject({
			ok: false,
			reason: "changed",
			holder: { sessionId: "c" },
		});
		expect((await readLeases()).map((entry) => entry.sessionId)).toEqual(["c"]);
	});

	it("makes an ordinary claimant wait for a transfer's decision", async () => {
		await acquireLease(request("a"));
		const conflict = await acquireLease(request("b"));
		if (conflict.ok) throw new Error("Expected a lease conflict");
		let enter!: () => void;
		let finish!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const stopped = new Promise<boolean>((resolve) => {
			finish = () => resolve(true);
		});
		const transfer = transferLease(request("b"), conflict.holder, () => {
			enter();
			return stopped;
		});
		await entered;
		const claimant = acquireLease(request("c"));
		finish();
		expect(await transfer).toEqual({ ok: true });
		expect(await claimant).toMatchObject({
			ok: false,
			holder: { sessionId: "b" },
		});
	});

	it("keeps ownership and releases the transfer gate when stopping throws", async () => {
		await acquireLease(request("a"));
		const conflict = await acquireLease(request("b"));
		if (conflict.ok) throw new Error("Expected a lease conflict");
		await expect(
			transferLease(request("b"), conflict.holder, async () => {
				throw new Error("stop failed");
			}),
		).rejects.toThrow("stop failed");
		expect(await acquireLease(request("c"))).toMatchObject({
			ok: false,
			holder: { sessionId: "a" },
		});
	});

	// A crashed run releases nothing, and must not hold anything either.
	it("treats a holder whose process is gone as free", async () => {
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				leases: [
					{
						...request("dead"),
						pid: 2_147_483_000,
						acquiredAt: new Date().toISOString(),
					},
				],
			}),
		);
		expect(await readLeases()).toEqual([]);
		expect(await acquireLease(request("b"))).toEqual({ ok: true });
	});

	it("releases every lease of a session", async () => {
		await acquireLease(request("a"));
		await acquireLease({ ...request("a"), key: "stripe-forwarder" });
		await releaseLeases("a");
		expect(await readLeases()).toEqual([]);
	});

	it("releases only the named leases of a session", async () => {
		await acquireLease(request("a"));
		await acquireLease({ ...request("a"), key: "stripe-forwarder" });
		await releaseLeases("a", { keys: ["stripe-forwarder"] });
		expect((await readLeases()).map((entry) => entry.key)).toEqual([
			request("a").key,
		]);
	});
});
