import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claimOffset,
	readAllOffsetClaims,
	withOffsetClaimsLock,
} from "../../core/offset-claims";
import { resolvePortPlan } from "../../core/port-allocation";
import { buildRunEntry, publishRun } from "../../core/run-registry";
import { handlePorts, parsePinnedOffset } from "./ports";

// The claims and the run registry live under HOME: the test's own, never the
// developer's. Releasing a claim asks no container runtime anything.
const originalHome = process.env.HOME;
const originalOffset = process.env.BUNCARGO_PORT_OFFSET;
const stdinTTY = process.stdin.isTTY;
let dir: string;
let stale: string;
let other: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-ports-release-")));
	process.env.HOME = join(dir, "home");
	delete process.env.BUNCARGO_PORT_OFFSET;
	process.stdin.isTTY = false;
	stale = join(dir, "old-worktree");
	other = join(dir, "other");
	mkdirSync(stale);
	mkdirSync(other);
	withOffsetClaimsLock(() => {
		claimOffset({
			root: stale,
			offset: 1100,
			ports: [6532],
			projectName: "lullu-playground",
		});
		claimOffset({
			root: stale,
			offset: 1200,
			ports: [6632],
			projectName: "lullu-playground-ci",
			suffix: "ci",
		});
		claimOffset({
			root: other,
			offset: 1300,
			ports: [6732],
			projectName: "lullu-other",
		});
	});
});
afterEach(() => {
	process.env.HOME = originalHome;
	if (originalOffset === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
	else process.env.BUNCARGO_PORT_OFFSET = originalOffset;
	process.stdin.isTTY = stdinTTY;
	rmSync(dir, { recursive: true, force: true });
});

const claimedNames = () =>
	Object.values(readAllOffsetClaims()).map((claim) => claim.projectName);

it("releases a stale claim that refuses another checkout, only once confirmed", async () => {
	const main = join(dir, "main");
	mkdirSync(main);
	const run = () =>
		resolvePortPlan({
			projectPrefix: "lullu",
			projectName: "lullu-playground",
			root: main,
			services: { postgres: { port: 5432 } },
			getOwner: () => null,
		});
	expect(run).toThrow(`\`buncargo ports release --root ${stale}\``);

	await expect(handlePorts(["release", "--root", stale])).rejects.toThrow(
		`Refusing to release ${stale}'s claims without a terminal.`,
	);
	expect(claimedNames()).toEqual([
		"lullu-playground",
		"lullu-playground-ci",
		"lullu-other",
	]);

	expect(await handlePorts(["release", "--root", stale, "--yes"])).toBe(0);
	expect(claimedNames()).toEqual(["lullu-other"]);
	expect(run().offset).toBeGreaterThan(0);
	expect(await handlePorts(["release", `--root=${stale}`, "--yes"])).toBe(0);
});

it("refuses to release the claims of a checkout that is running", async () => {
	await publishRun(
		buildRunEntry({
			sessionId: "ports-release-run",
			projectPrefix: "lullu",
			projectName: "lullu-playground",
			root: stale,
			isWorktree: false,
		}),
	);
	await expect(
		handlePorts(["release", "--root", stale, "--yes"]),
	).rejects.toThrow(`${stale} is running (pid ${process.pid})`);
	expect(claimedNames()).toHaveLength(3);
});

it("pins whole steps only, so a pinned block lines up with allocated ones", () => {
	expect(parsePinnedOffset("2500")).toBe(2500);
	for (const value of ["2550", "-100", "x", undefined])
		expect(() => parsePinnedOffset(value)).toThrow("steps of 100");
});

it("takes the checkout only through --root, and --root only for release", async () => {
	await expect(handlePorts(["release"])).rejects.toThrow(
		"ports release needs the checkout: --root <path>.",
	);
	await expect(handlePorts(["--root", stale])).rejects.toThrow(
		"--root and --yes are only for ports release.",
	);
	expect(claimedNames()).toHaveLength(3);
});
