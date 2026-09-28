import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	acquireLease,
	describeLeaseHolder,
	readLeases,
	releaseLeases,
} from "./leases";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "buncargo-leases-"));
	path = join(dir, "leases.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
		expect(await acquireLease(request("a"), { path })).toEqual({ ok: true });
		// Taking your own again is a no-op, not a conflict.
		expect(await acquireLease(request("a"), { path })).toEqual({ ok: true });

		const refused = await acquireLease(request("b"), { path });
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.holder.sessionId).toBe("a");
		expect(describeLeaseHolder(refused.holder)).toBe(
			`shop (main checkout, main), app "shopify", pid ${process.pid}`,
		);
	});

	it("moves the lease on a takeover", async () => {
		await acquireLease(request("a"), { path });
		expect(await acquireLease(request("b"), { path, force: true })).toEqual({
			ok: true,
		});
		expect((await readLeases(path)).map((lease) => lease.sessionId)).toEqual([
			"b",
		]);
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
		expect(await readLeases(path)).toEqual([]);
		expect(await acquireLease(request("b"), { path })).toEqual({ ok: true });
	});

	it("releases every lease of a session", async () => {
		await acquireLease(request("a"), { path });
		await acquireLease({ ...request("a"), key: "stripe-forwarder" }, { path });
		await releaseLeases("a", path);
		expect(await readLeases(path)).toEqual([]);
	});
});
