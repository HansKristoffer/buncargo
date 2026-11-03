import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	FULL_RANGE_BASE_PORT,
	fillPortRange,
} from "../../core/full-port-range.testing";
import {
	claimOffset,
	readAllOffsetClaims,
	withOffsetClaimsLock,
} from "../../core/offset-claims";
import { resolvePortPlan } from "../../core/port-allocation";
import { buildRunEntry, publishRun } from "../../core/run-registry";
import { CI_ENV_VARS } from "../../core/runtime-flags";
import { handlePorts, parsePinnedOffset } from "./ports";

const CLI = resolve(import.meta.dir, "../bin.ts");

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
		"ports release needs either the checkout (--root <path>) or an idle time (--idle=7d).",
	);
	await expect(handlePorts(["--root", stale])).rejects.toThrow(
		"--root, --idle and --yes are only for ports release.",
	);
	expect(claimedNames()).toHaveLength(3);
});

it("releases only the claims idle for longer than the duration, of checkouts with no run and no containers", async () => {
	const { roots } = fillPortRange(dir, [2, 30, 10]);
	// holder-2 was last used ten days ago, but its finished run's database
	// waits out the idle hold.
	await publishRun({
		...buildRunEntry({
			sessionId: "held",
			projectPrefix: "holder",
			projectName: "holder-2",
			root: roots[2],
			isWorktree: false,
		}),
		processIdentity: "v2:a run that has ended",
		services: [{ name: "db", status: "ready" }],
	});

	await expect(handlePorts(["release", "--idle=7d"])).rejects.toThrow(
		"Refusing to release 1 claim without a terminal.",
	);
	expect(await handlePorts(["release", "--idle", "7", "--yes"])).toBe(0);
	const reclaimed = Object.entries(readAllOffsetClaims())
		.filter(([, claim]) => claim.reclaimedAt !== undefined)
		.map(([key]) => key);
	expect(reclaimed).toEqual([roots[1]]);
	for (const value of ["soon", "0"])
		await expect(handlePorts(["release", `--idle=${value}`])).rejects.toThrow(
			`got "${value}"`,
		);
	await expect(handlePorts(["release", "--idle=soon"])).rejects.toThrow(
		'--idle takes a duration such as 7d, 12h or 30m (a bare number is days): got "soon".',
	);
	await expect(
		handlePorts(["release", "--idle=7d", "--root", stale]),
	).rejects.toThrow("ports release needs either the checkout");
});

it("answers status --json and ports in a checkout with no block while every block is claimed, and pins it", async () => {
	fillPortRange(dir, [2, 30, 10]);
	const checkout = join(dir, "fresh");
	mkdirSync(checkout);
	writeFileSync(
		join(checkout, "dev.config.ts"),
		`export default { projectPrefix: "fresh", services: { postgres: { port: ${FULL_RANGE_BASE_PORT} } } };`,
	);
	const cli = async (...args: string[]) => {
		const env: Record<string, string | undefined> = { ...process.env };
		for (const name of CI_ENV_VARS) delete env[name];
		const proc = Bun.spawn([process.execPath, CLI, ...args], {
			cwd: checkout,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, code };
	};

	const status = await cli("status", "--json");
	expect(status.code).toBe(0);
	expect(JSON.parse(status.stdout).portOffsetProvenance).toBe("unallocated");
	expect(status.stderr).toContain(`${checkout} has no port block yet`);

	const ports = await cli("ports");
	expect(ports.code).toBe(0);
	expect(ports.stdout).toContain("fresh-fresh: offset");
	expect(ports.stdout).toContain("(unallocated)");
	expect(ports.stdout).toContain(`${join(dir, "holder-1")} (30d ago, idle)`);

	const pin = await cli("ports", "pin", "9100");
	expect(pin.code).toBe(0);
	const pinned = await cli("status", "--json");
	expect(JSON.parse(pinned.stdout)).toMatchObject({
		portOffset: 9100,
		portOffsetProvenance: "lockfile",
	});
});
