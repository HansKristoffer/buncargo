import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimOffset,
	offsetClaimKey,
	readAllOffsetClaims,
	releaseOffsetClaimsIfUnchanged,
	releaseSuffixedClaimsOf,
	withOffsetClaimsLock,
} from "./offset-claims";

const realHome = process.env.HOME;
let home: string;
let root: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-offset-claims-"));
	root = mkdtempSync(join(home, "checkout-"));
	process.env.HOME = home;
});

afterEach(() => {
	setSystemTime();
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(home, { recursive: true, force: true });
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");

/** What a claiming run does at `at`: allocate the block and claim it. */
function claimAt(at: number, suffix = "ci"): void {
	setSystemTime(new Date(at));
	withOffsetClaimsLock(() =>
		claimOffset({
			root,
			offset: 300,
			ports: [5732],
			projectName: "demo-ci",
			suffix,
		}),
	);
}

describe("releaseOffsetClaimsIfUnchanged", () => {
	it("keeps a claim a run used after it was read", async () => {
		// `ports release --root` checks, then asks, then releases: a run that
		// started in between rewrote the claim and needs its block.
		claimAt(T0);
		const read = readAllOffsetClaims();
		claimAt(T0 + 60_000);

		expect(await releaseOffsetClaimsIfUnchanged(read)).toEqual([]);
		expect(Object.keys(readAllOffsetClaims())).toEqual([
			offsetClaimKey(root, "ci"),
		]);
	});

	it("drops a claim nothing touched since it was read", async () => {
		claimAt(T0);
		const read = readAllOffsetClaims();
		expect(await releaseOffsetClaimsIfUnchanged(read)).toEqual([
			offsetClaimKey(root, "ci"),
		]);
		expect(readAllOffsetClaims()).toEqual({});
	});
});

describe("releaseSuffixedClaimsOf", () => {
	const stack = () => ({ projectName: "demo-ci", root });

	it("releases the claim the torn-down run used", async () => {
		claimAt(T0);
		const owner = { startedAt: new Date(T0 + 1_000).toISOString() };
		await releaseSuffixedClaimsOf(stack(), readAllOffsetClaims(), owner);
		expect(readAllOffsetClaims()).toEqual({});
	});

	it("keeps a claim the next job of the directory wrote before it published its run", async () => {
		// A CI job allocates before it claims its run. The sweep tearing the
		// last job's stack down in that window deleted the new job's claim,
		// and two jobs then shared one block.
		const owner = { startedAt: new Date(T0).toISOString() };
		claimAt(T0 + 60_000);
		const read = readAllOffsetClaims();
		await releaseSuffixedClaimsOf(stack(), read, owner);
		expect(Object.keys(readAllOffsetClaims())).toEqual([
			offsetClaimKey(root, "ci"),
		]);
	});

	it("keeps a claim rewritten after the teardown read the claims", async () => {
		claimAt(T0);
		const read = readAllOffsetClaims();
		claimAt(T0 + 60_000);
		await releaseSuffixedClaimsOf(stack(), read, null);
		expect(Object.keys(readAllOffsetClaims())).toHaveLength(1);
	});
});
