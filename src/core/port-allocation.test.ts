import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApps, resolveServices } from "../config/resolve";
import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import {
	claimOffset,
	describeOffsetClaimOverlap,
	markOffsetClaimsReclaimed,
	type OffsetClaim,
	offsetClaimKey,
	overlappingOffsetClaims,
	readAllOffsetClaims,
	readHeldOffsetClaims,
	readOffsetClaims,
	sharedProjectNameClaims,
	withOffsetClaimsLock,
} from "./offset-claims";
import {
	type AllocatePortBlockInput,
	allocatePortBlock,
	type BlockCandidate,
	buildPortMap,
	chooseBlock,
	computeBaseOffset,
	maxPortOffset,
	PORT_OFFSET_STEP,
	pinOffset,
	readPortPlan,
} from "./port-allocation";
import type { BlockedOffset } from "./port-exhaustion";
import type { PortOwner } from "./process";
import { useTempHome } from "./test-env.testing";

const originalOffset = process.env.BUNCARGO_PORT_OFFSET;
// Offset claims live in ~/.buncargo: each test starts with none.
useTempHome();

afterEach(() => {
	if (originalOffset === undefined) {
		delete process.env.BUNCARGO_PORT_OFFSET;
	} else {
		process.env.BUNCARGO_PORT_OFFSET = originalOffset;
	}
});

/** A claiming run's allocation, as `dev` makes it. */
const allocate = (
	input: Omit<AllocatePortBlockInput, "claim"> & { claim?: boolean },
) => allocatePortBlock({ claim: true, ...input });

/** The claim a run on the block at `offset` left behind. */
function pinClaim(
	root: string,
	projectName: string,
	offset: number,
	ports: number[],
): void {
	withOffsetClaimsLock(() => claimOffset({ root, offset, ports, projectName }));
}

/** A claim that gave its block up: a full range reclaimed it, or its run was torn down. */
async function releasedClaim(
	root: string,
	projectName: string,
	offset: number,
	ports: number[],
): Promise<void> {
	pinClaim(root, projectName, offset, ports);
	const claim = readAllOffsetClaims()[root];
	if (!claim) throw new Error("claimed");
	await markOffsetClaimsReclaimed({ [root]: claim }, new Date().toISOString());
}

describe("buildPortMap", () => {
	it("adds offset to all service ports", () => {
		const services = resolveServices({
			postgres: { port: 5432 },
			redis: { port: 6379 },
		});

		const result = buildPortMap(services, undefined, 10);

		expect(result.postgres).toBe(5442);
		expect(result.redis).toBe(6389);
	});

	it("adds offset to all app ports", () => {
		const services = resolveServices({
			postgres: { port: 5432 },
		});
		const apps = resolveApps({
			api: { port: 3000, devCommand: "bun run dev" },
			web: { port: 5173, devCommand: "bun run dev:web" },
		});

		const result = buildPortMap(services, apps, 20);

		expect(result.api).toBe(3020);
		expect(result.web).toBe(5193);
	});

	it("derives a <name>Secondary entry for secondary ports", () => {
		const services = resolveServices({
			clickhouse: { port: 8123, secondaryPort: 9000 },
		});

		const result = buildPortMap(services, undefined, 15);

		expect(result.clickhouse).toBe(8138);
		expect(result.clickhouseSecondary).toBe(9015);
	});

	it("returns empty object when no services or apps", () => {
		expect(buildPortMap({}, undefined, 0)).toEqual({});
	});

	it("defaults to base ports when no offset is given", () => {
		const services = resolveServices({
			postgres: { port: 5432, secondaryPort: 5433 },
		});

		expect(buildPortMap(services, undefined)).toEqual({
			postgres: 5432,
			postgresSecondary: 5433,
		});
	});
});

describe("computeBaseOffset", () => {
	it("is deterministic for the same projectPrefix", () => {
		const first = computeBaseOffset({ projectPrefix: "geysier" });
		const second = computeBaseOffset({ projectPrefix: "geysier" });
		expect(first).toBe(second);
		expect(first % PORT_OFFSET_STEP).toBe(0);
		expect(first).toBeGreaterThanOrEqual(100);
	});

	it("changes when projectPrefix changes", () => {
		expect(computeBaseOffset({ projectPrefix: "alpha" })).not.toBe(
			computeBaseOffset({ projectPrefix: "beta" }),
		);
	});

	it("includes worktree only when isolation is on", () => {
		const isolated = computeBaseOffset({
			projectPrefix: "geysier",
			worktreeName: "feature-x",
			worktreeIsolation: true,
		});
		const shared = computeBaseOffset({
			projectPrefix: "geysier",
			worktreeName: "feature-x",
			worktreeIsolation: false,
		});
		const main = computeBaseOffset({ projectPrefix: "geysier" });
		expect(shared).toBe(main);
		expect(isolated).not.toBe(main);
	});
});

describe("allocatePortBlock", () => {
	const services = resolveServices({
		postgres: { port: 5432 },
	});
	const apps = resolveApps({
		api: { port: 3000, devCommand: "bun run dev" },
	});

	it("uses BUNCARGO_PORT_OFFSET as a hard override", () => {
		process.env.BUNCARGO_PORT_OFFSET = "250";
		const plan = allocate({
			projectPrefix: "geysier",
			projectName: "geysier-main",
			root: "/tmp/override",
			services,
			apps,
			claim: false,
			getOwner: () => {
				throw new Error("hard override must not probe");
			},
		});
		expect(plan.offset).toBe(250);
		expect(plan.provenance).toBe("env");
		expect(plan.ports.postgres).toBe(5682);
	});

	it("reuses its own claim's block", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-ports-"));
		try {
			pinClaim(root, "geysier-main", 300, [3300, 5732]);
			const plan = allocate({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
				getOwner: () => null,
			});
			expect(plan.offset).toBe(300);
			expect(plan.provenance).toBe("claim");
			expect(readOffsetClaims()[root]?.offset).toBe(300);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads the claim's block without probing it", () => {
		// getEnvVar reads this to answer a vite.config.ts; shifting would hand
		// it a port the running environment is not listening on.
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-readonly-"));
		try {
			pinClaim(root, "geysier-main", 300, [3300, 5732]);
			const plan = readPortPlan({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
			});
			expect(plan.offset).toBe(300);
			expect(plan.provenance).toBe("claim");
			expect(plan.ports.postgres).toBe(5732);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("shifts the whole block when a hashed port is held by a foreign owner", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-shift-"));
		const hashed = computeBaseOffset({ projectPrefix: "geysier" });
		const foreign: PortOwner = {
			kind: "process",
			pids: [99999],
			command: "vite",
			cwd: "/other/project",
		};
		try {
			const plan = allocate({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
				getOwner: (port) =>
					port === 5432 + hashed || port === 3000 + hashed ? foreign : null,
			});
			expect(plan.offset).toBe(hashed + PORT_OFFSET_STEP);
			expect(plan.provenance).toBe("shifted");
			expect(plan.ports.postgres).toBe(5432 + hashed + PORT_OFFSET_STEP);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the offset when the port is held by this project's own container", () => {
		// Shifting here is what made every Apple run recreate its containers:
		// a moved port changes the model, which changes the config hash.
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-own-"));
		const hashed = computeBaseOffset({ projectPrefix: "geysier" });
		const ours: PortOwner = {
			kind: "container",
			container: {
				id: "abc",
				name: "geysier-main-postgres",
				composeProject: "geysier-main",
				runtime: "apple",
			},
		};
		try {
			const plan = allocate({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
				runtime: { name: "apple" } as ContainerRuntimeAdapter,
				getOwner: () => ours,
			});
			expect(plan.offset).toBe(hashed);
			expect(plan.ports.postgres).toBe(5432 + hashed);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("still shifts when the holder is our container on the other runtime", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-cross-"));
		const hashed = computeBaseOffset({ projectPrefix: "geysier" });
		const otherRuntime: PortOwner = {
			kind: "container",
			container: {
				id: "abc",
				name: "geysier-main-postgres-1",
				composeProject: "geysier-main",
				runtime: "docker",
			},
		};
		try {
			const plan = allocate({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
				runtime: { name: "apple" } as ContainerRuntimeAdapter,
				getOwner: (port) =>
					port === 5432 + hashed || port === 3000 + hashed
						? otherRuntime
						: null,
			});
			expect(plan.offset).toBe(hashed + PORT_OFFSET_STEP);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("wraps around below its hashed offset when every block above it is taken", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-wrap-"));
		// A prefix that hashes high, so blocks above it run out first.
		const projectPrefix = Array.from({ length: 200 }, (_, i) => `p${i}`).find(
			(prefix) => computeBaseOffset({ projectPrefix: prefix }) >= 8000,
		);
		if (!projectPrefix) throw new Error("no prefix hashes high");
		const hashed = computeBaseOffset({ projectPrefix });
		const foreign: PortOwner = {
			kind: "process",
			pids: [99999],
			command: "vite",
			cwd: "/x",
		};
		try {
			const plan = allocate({
				projectPrefix,
				projectName: `${projectPrefix}-main`,
				root,
				services,
				apps,
				getOwner: (port) => (port - 5432 >= hashed ? foreign : null),
			});
			expect(plan.offset).toBe(100);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("names a block it tried, and why, when every block is taken", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-full-"));
		const hashed = computeBaseOffset({ projectPrefix: "geysier" });
		const otherRuntime: PortOwner = {
			kind: "container",
			container: {
				id: "abc",
				name: "geysier-main-postgres-1",
				composeProject: "geysier-main",
				runtime: "docker",
			},
		};
		try {
			let message = "";
			try {
				allocate({
					projectPrefix: "geysier",
					projectName: "geysier-main",
					root,
					services,
					apps,
					runtime: { name: "apple" } as ContainerRuntimeAdapter,
					getOwner: () => otherRuntime,
				});
			} catch (error) {
				message = String(error);
			}
			expect(message).toContain(
				`every offset from 100 to ${maxPortOffset(Object.values(buildPortMap(services, apps)))} (starting at ${hashed}) is taken.`,
			);
			expect(message).toContain(
				`at ${hashed}: port ${5432 + hashed} held by container geysier-main-postgres-1`,
			);
			// The selected backend reaches the owner's description.
			expect(message).toContain("running on Docker");
			expect(message).not.toContain("..");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

it("rejects an explicit offset that overflows a service port before any probe", () => {
	process.env.BUNCARGO_PORT_OFFSET = "1000";
	expect(() =>
		allocate({
			projectPrefix: "overflow",
			projectName: "overflow",
			root: "/tmp/overflow",
			services: { db: { port: 65000 } },
			apps: resolveApps({}),
			claim: false,
			getOwner: () => {
				throw new Error("unexpected probe");
			},
		}),
	).toThrow("Effective port for db is 66000");
});

it("applies the claim's offset to the ports the config has now", () => {
	delete process.env.BUNCARGO_PORT_OFFSET;
	const root = mkdtempSync(join(tmpdir(), "buncargo-claim-edit-"));
	try {
		pinClaim(root, "fixture", 100, [5532]);
		const plan = readPortPlan({
			root,
			projectPrefix: "fixture",
			projectName: "fixture",
			services: { postgres: { port: 6543 }, redis: { port: 6379 } },
		});
		expect(plan.ports).toEqual({ postgres: 6643, redis: 6479 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("a partial start cannot relocate the unselected claimed infrastructure", () => {
	delete process.env.BUNCARGO_PORT_OFFSET;
	const root = mkdtempSync(join(tmpdir(), "buncargo-claim-scope-"));
	try {
		pinClaim(root, "fixture", 100, [3100, 5532]);
		expect(() =>
			allocate({
				root,
				projectPrefix: "fixture",
				projectName: "fixture",
				services: { postgres: { port: 5432 } },
				apps: resolveApps({ marketing: { port: 3000, devCommand: false } }),
				probeNames: ["marketing"],
				getOwner: () => ({
					kind: "process",
					pids: [99999],
					command: "foreign",
					cwd: "/other",
				}),
			}),
		).toThrow("claimed allocation: port 3100 held by process 99999");
		expect(readOffsetClaims()[root]?.offset).toBe(100);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("chooseBlock", () => {
	const block = (offset: number): BlockCandidate => ({
		offset,
		ports: [5432 + offset, 3000 + offset],
	});
	const claimed = (offset: number, ports: number[] = []): OffsetClaim => ({
		offset,
		ports,
		projectName: `holder-${offset}`,
		updatedAt: "2026-01-01T00:00:00.000Z",
		usedAt: "2026-01-01T00:00:00.000Z",
	});

	it.each<{
		name: string;
		candidates: BlockCandidate[];
		claims?: Record<string, OffsetClaim>;
		busy?: number[];
		chosen?: number;
		blocked?: Partial<BlockedOffset>[];
	}>([
		{
			name: "takes the first block when nothing is in its way",
			candidates: [block(300), block(400)],
			chosen: 300,
		},
		{
			name: "passes over a block whose offset another checkout claims, running or not",
			candidates: [block(300), block(400)],
			claims: { "/a": claimed(300) },
			chosen: 400,
		},
		{
			name: "passes over a block sharing a port with a claim at another offset",
			candidates: [block(1100), block(1200)],
			// api 3000 at 1100 is admin 4000 at 100.
			claims: { "/a": claimed(100, [4100]) },
			chosen: 1200,
		},
		{
			name: "passes over a block a process holds a port of",
			candidates: [block(300), block(400)],
			busy: [300],
			chosen: 400,
		},
		{
			name: "says why each block is taken when every one is",
			candidates: [block(300), block(400), block(64_000)],
			claims: { "/a": claimed(300), "/b": claimed(1300, [3400]) },
			busy: [400],
			blocked: [
				{
					offset: 300,
					problem: "offset 300 is claimed by /a",
					claimKeys: ["/a"],
					unusable: false,
				},
				{
					offset: 400,
					problem: "port 3400 is in the block /b claims (offset 1300)",
					claimKeys: ["/b"],
					unusable: false,
				},
				{
					offset: 64_000,
					problem: "offset 64000 puts a port above 65535",
					unusable: true,
				},
			],
		},
		{
			name: "names every claim on a block, so a reclaim frees all of them",
			candidates: [block(300)],
			claims: { "/a": claimed(300), "/b": claimed(1300, [3300]) },
			blocked: [{ offset: 300, claimKeys: ["/a", "/b"], unusable: false }],
		},
		{
			name: "marks a block a process holds as unusable, which no reclaim frees",
			candidates: [block(300)],
			busy: [300],
			blocked: [
				{ offset: 300, problem: "held at 300", claimKeys: [], unusable: true },
			],
		},
	])(
		"$name",
		({ candidates, claims = {}, busy = [], chosen, blocked = [] }) => {
			const choice = chooseBlock(candidates, claims, (offset) =>
				busy.includes(offset) ? `held at ${offset}` : undefined,
			);
			if (chosen !== undefined) expect(choice).toEqual({ offset: chosen });
			else
				expect(choice).toEqual({
					blocked: blocked.map((entry) => expect.objectContaining(entry)),
				});
		},
	);

	it("probes only a block no claim holds and whose ports all exist", () => {
		const probed: number[] = [];
		chooseBlock(
			[block(300), block(64_000), block(400)],
			{ "/a": claimed(300) },
			(offset) => {
				probed.push(offset);
				return "held";
			},
		);
		expect(probed).toEqual([400]);
	});
});

describe("offset claims", () => {
	const plan = (root: string, projectName = "lullu-a") =>
		allocate({
			projectPrefix: "lullu",
			projectName,
			root,
			services: { postgres: { port: 5432 } },
			getOwner: () => null,
		});

	it("gives a second checkout that hashes to the same offset another block, even while the first is stopped", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const first = mkdtempSync(join(tmpdir(), "buncargo-claim-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-claim-b-"));
		const third = mkdtempSync(join(tmpdir(), "buncargo-claim-c-"));
		try {
			const a = plan(first);
			// Nothing is running: only the claim keeps the second one off it.
			const b = plan(second, "lullu-b");
			expect(b.offset).toBe(a.offset + PORT_OFFSET_STEP);
			expect(b.provenance).toBe("shifted");

			// Stable from then on, whichever starts first.
			expect(plan(second, "lullu-b").offset).toBe(b.offset);
			expect(plan(first).offset).toBe(a.offset);

			// A deleted checkout gives its offset back.
			rmSync(first, { recursive: true, force: true });
			expect(plan(third, "lullu-c").offset).toBe(a.offset);
		} finally {
			for (const root of [first, second, third])
				rmSync(root, { recursive: true, force: true });
		}
	});

	it("gives parallel suffixed environments their own offsets and keeps them, apart from dev's claim", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		// Two CI runners whose project names differ but hash the same.
		const first = mkdtempSync(join(tmpdir(), "buncargo-runner-1-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-runner-2-"));
		const suffixed = (root: string, read = false) => {
			const input = {
				projectPrefix: "lullu",
				projectName: `lullu-${root === first ? "1" : "2"}-app-ci`,
				root,
				suffix: "ci",
				services: { postgres: { port: 5432 } },
				getOwner: () => null,
			};
			return read ? readPortPlan(input) : allocate(input);
		};
		try {
			// Nothing is listening yet: the claim alone separates them.
			const a = suffixed(first);
			const b = suffixed(second);
			expect(b.offset).toBe(a.offset + PORT_OFFSET_STEP);

			expect(suffixed(second).offset).toBe(b.offset);
			expect(suffixed(first).offset).toBe(a.offset);
			expect(suffixed(second, true).offset).toBe(b.offset);

			const dev = plan(first);
			expect(readOffsetClaims()).toMatchObject({
				[first]: { offset: dev.offset },
				[offsetClaimKey(first, "ci")]: { offset: a.offset, root: first },
			});
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("refuses a checkout whose project name another existing checkout claims, until that one is gone", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		// The main clone's example/playground and a worktree's: one name.
		const first = mkdtempSync(join(tmpdir(), "buncargo-shared-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-shared-b-"));
		try {
			const a = plan(first, "lullu-playground");

			expect(() => plan(second, "lullu-playground")).toThrow(
				`${second} would run under Compose project lullu-playground, which ${first} already uses`,
			);
			// Refused before it wrote anything.
			expect(Object.keys(readOffsetClaims())).toEqual([first]);

			// The holder itself, and another name, still start.
			expect(plan(first, "lullu-playground").offset).toBe(a.offset);
			expect(() => plan(second, "lullu-playground-wt")).not.toThrow();

			// A deleted checkout's claim does not block the name.
			rmSync(first, { recursive: true, force: true });
			expect(() => plan(second, "lullu-playground")).not.toThrow();
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("refuses a second CI runner's stack under the same project name, under any offset", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		// Self-hosted runners: same directory name, so the same `-ci` project.
		const first = mkdtempSync(join(tmpdir(), "buncargo-runner-1-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-runner-2-"));
		const ci = (root: string) =>
			allocate({
				projectPrefix: "lullu",
				projectName: "lullu-app-ci",
				root,
				suffix: "ci",
				services: { postgres: { port: 5432 } },
				getOwner: () => null,
			});
		try {
			ci(first);
			expect(() => ci(second)).toThrow(`which ${first} (ci) already uses`);
			process.env.BUNCARGO_PORT_OFFSET = "2500";
			expect(() => ci(second)).toThrow(`which ${first} (ci) already uses`);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("does not refuse a read, its own checkout through a link, or a config without worktree isolation", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const first = mkdtempSync(join(tmpdir(), "buncargo-shared-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-shared-b-"));
		const link = `${first}-link`;
		symlinkSync(first, link);
		const shared = (
			root: string,
			options: Partial<AllocatePortBlockInput> = {},
		) =>
			allocate({
				projectPrefix: "lullu",
				projectName: "lullu-shared",
				root,
				services: { postgres: { port: 5432 } },
				getOwner: () => null,
				...options,
			});
		try {
			shared(first);
			expect(() => shared(link)).not.toThrow();
			expect(() =>
				readPortPlan({
					projectPrefix: "lullu",
					projectName: "lullu-shared",
					root: second,
					services: { postgres: { port: 5432 } },
				}),
			).not.toThrow();
			expect(() => shared(second, { worktreeIsolation: false })).not.toThrow();
		} finally {
			rmSync(link, { force: true });
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("says when the refused config sits below the top of a Git worktree", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const main = mkdtempSync(join(tmpdir(), "buncargo-main-"));
		const worktree = mkdtempSync(join(tmpdir(), "buncargo-wt-"));
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${main}/.git/worktrees/feature-x\n`,
		);
		const nested = join(worktree, "example", "playground");
		const top = join(main, "example", "playground");
		mkdirSync(nested, { recursive: true });
		mkdirSync(top, { recursive: true });
		try {
			plan(top, "lullu-playground");
			expect(() => plan(nested, "lullu-playground")).toThrow(
				`${nested} is below the top of Git worktree feature-x`,
			);
		} finally {
			rmSync(main, { recursive: true, force: true });
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it("reports claims whose blocks overlap through different offsets, and leaves out one that gave its block up", async () => {
		const api = mkdtempSync(join(tmpdir(), "buncargo-overlap-api-"));
		const admin = mkdtempSync(join(tmpdir(), "buncargo-overlap-admin-"));
		const older = mkdtempSync(join(tmpdir(), "buncargo-overlap-older-"));
		const apart = mkdtempSync(join(tmpdir(), "buncargo-overlap-apart-"));
		try {
			withOffsetClaimsLock(() => {
				// api 3000 at 1100 and admin 4000 at 100 are both 4100.
				claimOffset({
					root: api,
					offset: 1100,
					ports: [4100, 6532],
					projectName: "lullu-api",
				});
				claimOffset({
					root: admin,
					offset: 100,
					ports: [4100],
					projectName: "lullu-admin",
				});
				claimOffset({
					root: apart,
					offset: 2500,
					ports: [7932],
					projectName: "lullu-apart",
				});
			});
			// Its block went to others; it overlaps nobody.
			await releasedClaim(older, "lullu-older", 1200, [6532]);

			expect(
				overlappingOffsetClaims(readHeldOffsetClaims()).map(
					describeOffsetClaimOverlap,
				),
			).toEqual([
				`${api} (offset 1100) and ${admin} (offset 100) both claim port 4100`,
			]);
		} finally {
			for (const root of [api, admin, older, apart])
				rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports two claims on one offset even when they share no port", () => {
		const at = (offset: number, projectName: string): OffsetClaim => ({
			offset,
			ports: [],
			projectName,
			updatedAt: "",
			usedAt: "",
		});
		expect(
			overlappingOffsetClaims({
				"/a": at(300, "a"),
				"/b": at(300, "b"),
				"/c": at(400, "c"),
			}).map(describeOffsetClaimOverlap),
		).toEqual(["/a and /b both claim offset 300"]);
	});

	it("lists the project names more than one existing checkout claims", () => {
		const first = mkdtempSync(join(tmpdir(), "buncargo-shared-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-shared-b-"));
		const claim = (
			root: string,
			offset: number,
			projectName: string,
			suffix?: string,
		) => claimOffset({ root, offset, ports: [], projectName, suffix });
		try {
			withOffsetClaimsLock(() => {
				claim(first, 100, "lullu-x");
				claim(second, 200, "lullu-x");
				claim(second, 300, "lullu-x-ci", "ci");
			});
			expect(sharedProjectNameClaims(readOffsetClaims())).toEqual(
				new Map([["lullu-x", [first, second]]]),
			);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("never gives two checkouts overlapping blocks, whatever their offsets", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		// a 3000 and b 3100: offset 200 is 3200/3300, offset 100 is 3100/3200.
		const first = mkdtempSync(join(tmpdir(), "buncargo-overlap-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-overlap-b-"));
		const blocks = (root: string, projectName: string) =>
			allocate({
				projectPrefix: "lullu",
				projectName,
				root,
				services: { a: { port: 3000 }, b: { port: 3100 } },
				getOwner: () => null,
			});
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => warnings.push(String(message));
		try {
			pinClaim(first, "lullu-a", 200, [3200, 3300]);
			await releasedClaim(second, "lullu-b", 100, [3100, 3200]);
			const a = blocks(first, "lullu-a");
			const b = blocks(second, "lullu-b");
			expect(a.offset).toBe(200);
			const taken = new Set(Object.values(a.ports));
			expect(Object.values(b.ports).filter((port) => taken.has(port))).toEqual(
				[],
			);
			expect(warnings.join("\n")).toContain(
				`port 3200 is in the block ${first} claims`,
			);
			// The move sticks, whichever starts next.
			expect(blocks(first, "lullu-a").offset).toBe(a.offset);
			expect(blocks(second, "lullu-b").offset).toBe(b.offset);
		} finally {
			console.warn = warn;
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("claims a block's Tailscale HTTPS ports without probing them, and keeps other checkouts off them", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const first = mkdtempSync(join(tmpdir(), "buncargo-https-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-https-b-"));
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => warnings.push(String(message));
		try {
			pinClaim(first, "lullu-a", 200, [5373]);
			await releasedClaim(second, "lullu-b", 100, [25273]);
			// Tailscale's listener on the first checkout's own HTTPS port fails
			// the bind probe, exactly as a stranger would.
			const a = allocate({
				projectPrefix: "lullu",
				projectName: "lullu-a",
				root: first,
				services: {},
				apps: resolveApps({ web: { port: 5173, devCommand: "true" } }),
				getOwner: (port) => (port === 25373 ? { kind: "unidentified" } : null),
				companionPorts: (ports) =>
					ports.web === undefined ? [] : [ports.web + 20_000],
			});
			expect(a.offset).toBe(200);
			expect(readOffsetClaims()[first]?.ports).toEqual([5373, 25373]);

			// 25273 at offset 100 is the first checkout's HTTPS port.
			const b = allocate({
				projectPrefix: "lullu",
				projectName: "lullu-b",
				root: second,
				services: { other: { port: 25273 } },
				getOwner: () => null,
			});
			expect(b.offset).not.toBe(100);
			expect(warnings.join("\n")).toContain(
				`port 25373 is in the block ${first} claims`,
			);
		} finally {
			console.warn = warn;
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("claims and probes an app's extra ports with its block", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const first = mkdtempSync(join(tmpdir(), "buncargo-extra-a-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-extra-b-"));
		const warn = console.warn;
		console.warn = () => {};
		// An emulator suite: the UI is the app's port, the emulators 100 apart,
		// which is exactly the offset step.
		const apps = resolveApps({
			firebase: { port: 4000, extraPorts: [9099, 9199], devCommand: "true" },
		});
		try {
			pinClaim(first, "fb-a", 100, [4100]);
			await releasedClaim(second, "fb-b", 0, [4000, 9099, 9199]);
			const a = allocate({
				projectPrefix: "fb",
				projectName: "fb-a",
				root: first,
				services: {},
				apps,
				getOwner: () => null,
			});
			expect(a.offset).toBe(100);
			expect(readOffsetClaims()[first]?.ports).toEqual([4100, 9199, 9299]);

			// At offset 0 the second checkout's 9199 is the first one's auth port.
			const b = allocate({
				projectPrefix: "fb",
				projectName: "fb-b",
				root: second,
				services: {},
				apps,
				getOwner: () => null,
			});
			expect(b.offset).not.toBe(0);

			// And a stranger on an extra port moves the block too.
			const third = allocate({
				projectPrefix: "fb",
				projectName: "fb-c",
				root: second,
				services: {},
				apps,
				getOwner: (port) =>
					port === 9099 + b.offset
						? {
								kind: "process",
								pids: [99999],
								command: "java",
								cwd: "/elsewhere",
							}
						: null,
			});
			expect(third.offset).not.toBe(b.offset);
		} finally {
			console.warn = warn;
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("refuses a partial start whose claimed block another checkout's claim overlaps", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-partial-claim-"));
		const other = mkdtempSync(join(tmpdir(), "buncargo-partial-other-"));
		try {
			pinClaim(root, "lullu-a", 100, [3100, 5532]);
			withOffsetClaimsLock(() =>
				claimOffset({
					root: other,
					offset: 1100,
					ports: [3100],
					projectName: "lullu-b",
				}),
			);
			expect(() =>
				allocate({
					root,
					projectPrefix: "lullu",
					projectName: "lullu-a",
					services: { postgres: { port: 5432 } },
					apps: resolveApps({ marketing: { port: 3000, devCommand: false } }),
					probeNames: ["marketing"],
					getOwner: () => null,
				}),
			).toThrow(
				`claimed allocation: port 3100 is in the block ${other} claims`,
			);
			expect(readOffsetClaims()[root]?.offset).toBe(100);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("says why its claimed block is not used when another checkout took it", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-moved-"));
		const other = mkdtempSync(join(tmpdir(), "buncargo-taker-"));
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => warnings.push(String(message));
		try {
			await releasedClaim(root, "lullu-a", 2500, [7932]);
			pinClaim(other, "lullu-b", 2500, [7932]);
			const allocated = plan(root);
			expect(allocated.offset).not.toBe(2500);
			expect(warnings.join("\n")).toContain(
				`Offset 2500 not used: offset 2500 is claimed by ${other}`,
			);
		} finally {
			console.warn = warn;
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});
});

describe("pinOffset", () => {
	const services = { postgres: { port: 5432 } };

	it("claims the block", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-pin-"));
		try {
			expect(
				pinOffset({
					root,
					projectName: "lullu-a",
					services,
					offset: 2500,
					getOwner: () => null,
				}),
			).toEqual({ pinned: { postgres: 7932 } });
			expect(readOffsetClaims()[root]).toMatchObject({
				offset: 2500,
				ports: [7932],
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a project name another existing checkout claims, as a run does", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-pin-"));
		const other = mkdtempSync(join(tmpdir(), "buncargo-pin-other-"));
		const pin = (worktreeIsolation?: boolean) =>
			pinOffset({
				root,
				projectName: "lullu-a",
				services,
				offset: 2500,
				worktreeIsolation,
				getOwner: () => null,
			});
		try {
			withOffsetClaimsLock(() =>
				claimOffset({
					root: other,
					offset: 1100,
					ports: [6532],
					projectName: "lullu-a",
				}),
			);
			const result = pin();
			expect(result).toMatchObject({ claimed: false });
			expect("refused" in result && result.refused).toContain(
				`${root} would run under Compose project lullu-a, which ${other} already uses`,
			);
			expect(() =>
				allocate({
					projectPrefix: "lullu",
					projectName: "lullu-a",
					root,
					services,
					getOwner: () => null,
				}),
			).toThrow("refused" in result ? result.refused : "");
			expect(Object.keys(readOffsetClaims())).toEqual([other]);

			expect(pin(false)).toEqual({ pinned: { postgres: 7932 } });
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("leaves a block another checkout claimed while its ports were probed", () => {
		const root = mkdtempSync(join(tmpdir(), "buncargo-pin-"));
		const other = mkdtempSync(join(tmpdir(), "buncargo-pin-other-"));
		try {
			const result = pinOffset({
				root,
				projectName: "lullu-a",
				services,
				offset: 2500,
				// The probe runs outside the claims lock, so another checkout's
				// allocation can take the block meanwhile.
				getOwner: () => {
					withOffsetClaimsLock(() =>
						claimOffset({
							root: other,
							offset: 2500,
							ports: [7932],
							projectName: "lullu-b",
						}),
					);
					return null;
				},
			});
			expect(result).toEqual({
				refused: `Offset 2500 is not free: offset 2500 is claimed by ${other}.`,
				claimed: true,
			});
			expect(Object.keys(readOffsetClaims())).toEqual([other]);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});
});
