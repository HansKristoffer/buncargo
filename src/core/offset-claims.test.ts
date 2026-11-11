import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimOffset,
	getOffsetClaimsPath,
	offsetClaimHoldsBlock,
	offsetClaimKey,
	readAllOffsetClaims,
	releaseSuffixedClaimsOf,
	retireOffsetClaimsIfUnchanged,
	withOffsetClaimsLock,
} from "./offset-claims";
import {
	StateFileUnreadableError,
	StateFileVersionError,
} from "./registry-file";

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
const HOUR = 3_600_000;

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

/** Whether the suffixed claim of `root` is on record, and holds its block. */
function ciClaim(): "holds" | "released" | "gone" {
	const claim = readAllOffsetClaims()[offsetClaimKey(root, "ci")];
	if (!claim) return "gone";
	return offsetClaimHoldsBlock(claim) ? "holds" : "released";
}

describe("retireOffsetClaimsIfUnchanged", () => {
	it("keeps a claim a run used after it was read", async () => {
		// `ports release --root` checks, then asks, then releases: a run that
		// started in between rewrote the claim and needs its block.
		claimAt(T0);
		const read = readAllOffsetClaims();
		claimAt(T0 + 60_000);

		expect(await retireOffsetClaimsIfUnchanged(read)).toEqual([]);
		expect(Object.keys(readAllOffsetClaims())).toEqual([
			offsetClaimKey(root, "ci"),
		]);
	});

	it("drops a claim nothing touched since it was read", async () => {
		claimAt(T0);
		const read = readAllOffsetClaims();
		expect(await retireOffsetClaimsIfUnchanged(read)).toEqual([
			offsetClaimKey(root, "ci"),
		]);
		expect(readAllOffsetClaims()).toEqual({});
	});
});

describe("releaseSuffixedClaimsOf", () => {
	const stack = () => ({ projectName: "demo-ci", root });

	it("frees the block the torn-down run used, and keeps who owns the project", async () => {
		// The stack's volumes outlive it. Dropping the claim left nothing
		// naming their project, so once the checkout was deleted neither the
		// sweep nor `prune` could tell they were its.
		claimAt(T0);
		const owner = { startedAt: new Date(T0 + 1_000).toISOString() };
		await releaseSuffixedClaimsOf(
			stack(),
			readAllOffsetClaims(),
			owner,
			T0 + 1_000,
		);
		expect(ciClaim()).toBe("released");
		expect(readAllOffsetClaims()[offsetClaimKey(root, "ci")]).toMatchObject({
			projectName: "demo-ci",
			root,
			suffix: "ci",
		});
	});

	it("gives the block back to the environment's next claiming run", async () => {
		claimAt(T0);
		await releaseSuffixedClaimsOf(
			stack(),
			readAllOffsetClaims(),
			{ startedAt: new Date(T0 + 1_000).toISOString() },
			T0 + 1_000,
		);
		claimAt(T0 + HOUR);
		expect(ciClaim()).toBe("holds");
	});

	it("keeps a claim the next job of the directory wrote before it published its run", async () => {
		// A CI job allocates before it claims its run. The sweep tearing the
		// last job's stack down in that window deleted the new job's claim,
		// and two jobs then shared one block.
		const owner = { startedAt: new Date(T0).toISOString() };
		claimAt(T0 + 60_000);
		const read = readAllOffsetClaims();
		await releaseSuffixedClaimsOf(stack(), read, owner, T0 + 60_000);
		expect(ciClaim()).toBe("holds");
	});

	it("keeps a claim rewritten after the teardown read the claims", async () => {
		claimAt(T0);
		const read = readAllOffsetClaims();
		claimAt(T0 + 60_000);
		await releaseSuffixedClaimsOf(stack(), read, null, T0 + 3 * HOUR);
		expect(ciClaim()).toBe("holds");
	});

	it("keeps a recent claim of a stack with no run on record", async () => {
		// The sweep downs a stack nobody owns. A new job of the directory that
		// has allocated but not yet published its run has only this claim.
		claimAt(T0);
		const read = readAllOffsetClaims();
		await releaseSuffixedClaimsOf(stack(), read, null, T0 + 60_000);
		expect(ciClaim()).toBe("holds");
	});

	it("frees the block of an hour-old claim of a stack with no run on record", async () => {
		claimAt(T0);
		const read = readAllOffsetClaims();
		await releaseSuffixedClaimsOf(stack(), read, null, T0 + HOUR);
		expect(ciClaim()).toBe("released");
	});
});

describe("readAllOffsetClaims", () => {
	it("reads a claim without its ports or usedAt as no claim", () => {
		// 16.0 dropped the reader for claims older buncargo wrote with their
		// offset alone, and `.buncargo/ports.json` that filled their ports.
		mkdirSync(join(home, ".buncargo"), { recursive: true });
		const claim = { offset: 300, projectName: "demo", updatedAt: "x" };
		writeFileSync(
			getOffsetClaimsPath(),
			JSON.stringify({
				version: 1,
				claims: {
					"/old": claim,
					"/new": { ...claim, ports: [5732], usedAt: "x" },
				},
			}),
		);
		expect(Object.keys(readAllOffsetClaims())).toEqual(["/new"]);
	});

	it("keeps a claim whose optional field is malformed, without that field", () => {
		mkdirSync(join(home, ".buncargo"), { recursive: true });
		const required = {
			offset: 300,
			ports: [5732],
			projectName: "demo",
			updatedAt: "x",
			usedAt: "x",
		};
		writeFileSync(
			getOffsetClaimsPath(),
			JSON.stringify({
				version: 1,
				claims: {
					"/repo#ci": {
						...required,
						root: "/repo",
						suffix: "ci",
						reclaimedAt: 12,
						throwaway: "yes",
					},
				},
			}),
		);
		expect(readAllOffsetClaims()).toEqual({
			"/repo#ci": { ...required, root: "/repo", suffix: "ci" },
		});
	});
});

describe("claimOffset", () => {
	// Several buncargo versions share the file. One that took a file it could
	// not read for empty wrote back its own claim alone, and every other
	// checkout lost its block and the record that keeps its volumes.
	it.each([
		["a corrupt file", "{ not json", StateFileUnreadableError],
		[
			"a newer version",
			`${JSON.stringify({ version: 2, claims: { "/other": { offset: 100 } } })}\n`,
			StateFileVersionError,
		],
	])("leaves %s untouched and throws", (_, bytes, errorType) => {
		mkdirSync(join(home, ".buncargo"), { recursive: true });
		writeFileSync(getOffsetClaimsPath(), bytes);

		expect(() => claimAt(T0)).toThrow(errorType);
		expect(readFileSync(getOffsetClaimsPath(), "utf-8")).toBe(bytes);
	});

	it("records a throwaway claim as one, and a later claim of the key that is not throwaway as not", () => {
		// The sweep frees only marked claims: a dev claim of the same root
		// must not inherit the mark of a CI run's.
		const claim = (throwaway: boolean) =>
			withOffsetClaimsLock(() =>
				claimOffset({
					root,
					offset: 300,
					ports: [5732],
					projectName: "demo",
					throwaway,
				}),
			);

		claim(true);
		expect(readAllOffsetClaims()[root]?.throwaway).toBe(true);
		claim(false);
		expect(readAllOffsetClaims()[root]).not.toHaveProperty("throwaway");
	});
});
