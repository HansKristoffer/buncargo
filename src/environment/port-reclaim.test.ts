import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FULL_RANGE_BASE_PORT,
	fillPortRange,
} from "../core/full-port-range.testing";
import { claimOffset, readAllOffsetClaims } from "../core/offset-claims";
import {
	allocatePortBlock,
	computeBaseOffset,
	readPortPlan,
} from "../core/port-allocation";
import { buildRunEntry, publishRun } from "../core/run-registry";
import { createDevEnvironment } from "./create-dev-environment";
import { allocateReclaiming } from "./port-reclaim";

// Claims and runs live under the test's own HOME. No container runtime
// answers here (the preload's stubs), so a checkout holds containers only
// through a finished run on record.
const saved = {
	HOME: process.env.HOME,
	OFFSET: process.env.BUNCARGO_PORT_OFFSET,
};
let dir: string;
let newRoot: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-reclaim-")));
	process.env.HOME = join(dir, "home");
	delete process.env.BUNCARGO_PORT_OFFSET;
	newRoot = join(dir, "new");
	mkdirSync(newRoot);
});
afterEach(() => {
	process.env.HOME = saved.HOME;
	if (saved.OFFSET === undefined) delete process.env.BUNCARGO_PORT_OFFSET;
	else process.env.BUNCARGO_PORT_OFFSET = saved.OFFSET;
	rmSync(dir, { recursive: true, force: true });
});

const services = { db: { port: FULL_RANGE_BASE_PORT } };

/** A claiming start's allocation, with every port free on the machine. */
const allocate = () =>
	allocateReclaiming(() =>
		allocatePortBlock({
			claim: true,
			projectPrefix: "fresh",
			projectName: "fresh-new",
			root: newRoot,
			services,
			getOwner: () => null,
		}),
	);

it("reclaims the least recently used block of stopped checkouts when every block is claimed", async () => {
	const { roots } = fillPortRange(dir, [2, 30, 10]);
	const reclaimed = roots[1];
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	let taken = 0;
	try {
		const plan = await allocate();
		taken = plan.offset;

		// holder-1 (offsets 3100 to 6000) was used longest ago.
		expect(plan.offset).toBeGreaterThanOrEqual(3100);
		expect(plan.offset).toBeLessThanOrEqual(6000);
		// The claim stays, without its block: the checkout keeps its project
		// name, and `prune` still counts it as an existing checkout.
		const after = readAllOffsetClaims();
		expect(Object.keys(after).sort()).toEqual([...roots, newRoot].sort());
		expect(after[reclaimed]?.reclaimedAt).toBeString();
		expect(after[roots[0]]?.reclaimedAt).toBeUndefined();
		expect(String(warn.mock.calls[0]?.[0])).toContain(
			`reclaimed offset 3100 from ${reclaimed} (idle, last used 30d ago)`,
		);
	} finally {
		warn.mockRestore();
	}

	// Its claim still records the block the new checkout now holds part of:
	// a read of it must not hand out those ports.
	const read = readPortPlan({
		projectPrefix: "holder",
		projectName: "holder-1",
		root: reclaimed,
		services,
	});
	expect(read.ports.db).not.toBe(FULL_RANGE_BASE_PORT + taken);

	// Another checkout still may not run under its project name.
	const twin = join(dir, "twin");
	mkdirSync(twin);
	expect(() =>
		allocatePortBlock({
			claim: true,
			projectPrefix: "holder",
			projectName: "holder-1",
			root: twin,
			services,
			getOwner: () => null,
		}),
	).toThrow(`which ${reclaimed} already uses`);
});

it("fails with every holder and its state when every block is claimed by checkouts in use", async () => {
	const { roots, claims } = fillPortRange(dir, [2, 30, 10]);
	for (const [index, root] of roots.entries()) {
		const entry = buildRunEntry({
			sessionId: `holder-${index}`,
			projectPrefix: "holder",
			projectName: `holder-${index}`,
			root,
			isWorktree: false,
		});
		// holder-1's run has ended and left its database in the idle hold.
		await publishRun(
			index === 1
				? {
						...entry,
						processIdentity: "v2:a run that has ended",
						services: [{ name: "db", status: "ready" }],
					}
				: entry,
		);
	}

	const failure = await allocate().then(
		() => "",
		(error: unknown) => String(error),
	);

	expect(failure).toContain("every offset from 100 to 9000 (starting at");
	expect(failure).toContain("No block could be reclaimed");
	expect(failure).toContain(`  ${roots[0]} (running, last used`);
	expect(failure).toContain(
		`  ${roots[1]} (containers held, last used 30d ago)`,
	);
	expect(failure).toContain(`  ${roots[2]} (running, last used 10d ago)`);
	expect(failure).toContain("`buncargo ports pin 9100`");
	expect(readAllOffsetClaims()).toEqual(claims);
});

it("leaves nothing selected when a start finds every block claimed", async () => {
	const { roots } = fillPortRange(dir, [2, 30, 10]);
	for (const [index, root] of roots.entries())
		await publishRun(
			buildRunEntry({
				sessionId: `holder-${index}`,
				projectPrefix: "holder",
				projectName: `holder-${index}`,
				root,
				isWorktree: false,
			}),
		);
	const env = createDevEnvironment(
		{
			projectPrefix: "fresh",
			services: { postgres: { port: FULL_RANGE_BASE_PORT } },
			prisma: {},
			options: { verbose: false },
		},
		{ root: newRoot },
	);

	await expect(env.prepareStartAsync()).rejects.toThrow(
		"No block could be reclaimed",
	);
	// Prisma allocates for itself rather than run on the unprobed preview.
	await expect(env.prisma?.ensureDatabase()).rejects.toThrow(
		"No block could be reclaimed",
	);
});

it("moves past one block another checkout claims without reclaiming it", async () => {
	const hashed = computeBaseOffset({ projectPrefix: "fresh" });
	const other = join(dir, "other");
	mkdirSync(other);
	claimOffset({
		root: other,
		offset: hashed,
		ports: [FULL_RANGE_BASE_PORT + hashed],
		projectName: "other",
	});

	const plan = await allocate();

	expect(plan.offset).not.toBe(hashed);
	expect(readAllOffsetClaims()[other]?.offset).toBe(hashed);
});

it("answers a read of a checkout with no block, and refuses to run a command on another checkout's ports", async () => {
	fillPortRange(dir, [2, 30, 10]);
	const env = createDevEnvironment(
		{
			projectPrefix: "fresh",
			services: { postgres: { port: FULL_RANGE_BASE_PORT } },
			options: { verbose: false },
		},
		{ root: newRoot },
	);

	expect(env.portOffsetProvenance).toBe("unallocated");
	expect(env.portOffset).toBe(computeBaseOffset({ projectPrefix: "fresh" }));
	await expect(env.exec(["true"])).rejects.toThrow(
		`${newRoot} has no port block yet`,
	);
});
