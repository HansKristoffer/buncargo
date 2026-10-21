import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import type { AppConfig, ServiceConfig } from "../types";
import {
	claimOffset,
	describeOffsetClaimOverlap,
	offsetClaimKey,
	overlappingOffsetClaims,
	readOffsetClaims,
	sharedProjectNameClaims,
	withOffsetClaimsLock,
} from "./offset-claims";
import {
	buildPortMap,
	computeBaseOffset,
	PORT_OFFSET_STEP,
	pinOffset,
	readOffsetClaimsWithPorts,
	readPortsLockfile,
	resolvePortPlan,
	writePortsLockfile,
} from "./port-allocation";
import type { PortOwner } from "./process";

const originalOffset = process.env.BUNCARGO_PORT_OFFSET;
// Offset claims live in ~/.buncargo: never the developer's.
const originalHome = process.env.HOME;
let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "buncargo-claims-"));
	process.env.HOME = home;
});

afterEach(() => {
	process.env.HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
	if (originalOffset === undefined) {
		delete process.env.BUNCARGO_PORT_OFFSET;
	} else {
		process.env.BUNCARGO_PORT_OFFSET = originalOffset;
	}
});

describe("buildPortMap", () => {
	it("adds offset to all service ports", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432 },
			redis: { port: 6379 },
		};

		const result = buildPortMap(services, undefined, 10);

		expect(result.postgres).toBe(5442);
		expect(result.redis).toBe(6389);
	});

	it("adds offset to all app ports", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432 },
		};
		const apps: Record<string, AppConfig> = {
			api: { port: 3000, devCommand: "bun run dev" },
			web: { port: 5173, devCommand: "bun run dev:web" },
		};

		const result = buildPortMap(services, apps, 20);

		expect(result.api).toBe(3020);
		expect(result.web).toBe(5193);
	});

	it("derives a <name>Secondary entry for secondary ports", () => {
		const services: Record<string, ServiceConfig> = {
			clickhouse: { port: 8123, secondaryPort: 9000 },
		};

		const result = buildPortMap(services, undefined, 15);

		expect(result.clickhouse).toBe(8138);
		expect(result.clickhouseSecondary).toBe(9015);
	});

	it("returns empty object when no services or apps", () => {
		expect(buildPortMap({}, undefined, 0)).toEqual({});
	});

	it("defaults to base ports when no offset is given", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432, secondaryPort: 5433 },
		};

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

describe("resolvePortPlan", () => {
	const services: Record<string, ServiceConfig> = {
		postgres: { port: 5432 },
	};
	const apps: Record<string, AppConfig> = {
		api: { port: 3000, devCommand: "bun run dev" },
	};

	it("uses BUNCARGO_PORT_OFFSET as a hard override", () => {
		process.env.BUNCARGO_PORT_OFFSET = "250";
		const plan = resolvePortPlan({
			projectPrefix: "geysier",
			projectName: "geysier-main",
			root: "/tmp/override",
			services,
			apps,
			persist: false,
			getOwner: () => {
				throw new Error("hard override must not probe");
			},
		});
		expect(plan.offset).toBe(250);
		expect(plan.provenance).toBe("env");
		expect(plan.ports.postgres).toBe(5682);
	});

	it("reuses a valid lockfile", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-ports-"));
		try {
			writePortsLockfile(root, {
				version: 1,
				projectName: "geysier-main",
				root,
				offset: 300,
				ports: buildPortMap(
					{ postgres: { port: 5432 } },
					{ api: { port: 3000, devCommand: "bun run dev" } },
					300,
				),
				provenance: "hash",
			});
			const plan = resolvePortPlan({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
				getOwner: () => null,
			});
			expect(plan.offset).toBe(300);
			expect(plan.provenance).toBe("lockfile");
			expect(readPortsLockfile(root)?.offset).toBe(300);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the lockfile offset when conflict probing is off", () => {
		// getEnvVar reads this to answer a vite.config.ts; shifting would hand
		// it a port the running environment is not listening on.
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-readonly-"));
		const foreign: PortOwner = {
			pids: [999],
			command: "some-other-tool",
			cwd: "/tmp/elsewhere",
		};
		try {
			writePortsLockfile(root, {
				version: 1,
				projectName: "geysier-main",
				root,
				offset: 300,
				ports: buildPortMap(
					{ postgres: { port: 5432 } },
					{ api: { port: 3000, devCommand: "bun run dev" } },
					300,
				),
				provenance: "hash",
			});
			const plan = resolvePortPlan({
				projectPrefix: "geysier",
				projectName: "geysier-main",
				root,
				services,
				apps,
				persist: false,
				probeConflicts: false,
				getOwner: () => foreign,
			});
			expect(plan.offset).toBe(300);
			expect(plan.provenance).toBe("lockfile");
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
			pids: [99999],
			command: "vite",
			cwd: "/other/project",
		};
		try {
			const plan = resolvePortPlan({
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
			pids: [4242],
			command: "container",
			cwd: "/",
			container: {
				id: "abc",
				name: "geysier-main-postgres",
				composeProject: "geysier-main",
				runtime: "apple",
			},
		};
		try {
			const plan = resolvePortPlan({
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
			pids: [4242],
			command: "com.docker.backend",
			cwd: "/",
			container: {
				id: "abc",
				name: "geysier-main-postgres-1",
				composeProject: "geysier-main",
				runtime: "docker",
			},
		};
		try {
			const plan = resolvePortPlan({
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
		const foreign: PortOwner = { pids: [99999], command: "vite", cwd: "/x" };
		try {
			const plan = resolvePortPlan({
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

	it("names the last block it tried, and why, when every block is taken", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-full-"));
		const hashed = computeBaseOffset({ projectPrefix: "geysier" });
		const otherRuntime: PortOwner = {
			pids: [4242],
			command: "com.docker.backend",
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
				resolvePortPlan({
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
			// Every block, from the hashed one around to the one below it.
			const last = hashed === 100 ? 9000 : hashed - PORT_OFFSET_STEP;
			expect(message).toContain(
				`(every offset from 100 to 9000, starting at ${hashed}); at ${last}, port ${5432 + last} held by container geysier-main-postgres-1`,
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
		resolvePortPlan({
			projectPrefix: "overflow",
			projectName: "overflow",
			root: "/tmp/overflow",
			services: { db: { port: 65000 } },
			apps: {},
			persist: false,
			getOwner: () => {
				throw new Error("unexpected probe");
			},
		}),
	).toThrow("Effective port for db is 66000");
});

it("read-only commands keep persisted endpoints across configuration edits", () => {
	delete process.env.BUNCARGO_PORT_OFFSET;
	const root = mkdtempSync(join(tmpdir(), "buncargo-persisted-edit-"));
	try {
		writePortsLockfile(root, {
			version: 1,
			projectName: "fixture",
			root,
			offset: 100,
			ports: { postgres: 5532 },
			provenance: "hash",
		});
		const plan = resolvePortPlan({
			root,
			projectPrefix: "fixture",
			projectName: "fixture",
			services: { postgres: { port: 6543 }, redis: { port: 6379 } },
			persist: false,
			probeConflicts: false,
			getOwner: () => {
				throw new Error("must not probe");
			},
		});
		expect(plan.ports).toEqual({ postgres: 5532, redis: 6479 });
		expect(readPortsLockfile(root)?.ports).toEqual({ postgres: 5532 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
it("a partial start cannot relocate the unselected persisted infrastructure", () => {
	delete process.env.BUNCARGO_PORT_OFFSET;
	const root = mkdtempSync(join(tmpdir(), "buncargo-persisted-scope-"));
	try {
		writePortsLockfile(root, {
			version: 1,
			projectName: "fixture",
			root,
			offset: 100,
			ports: { postgres: 5532, marketing: 3100 },
			provenance: "hash",
		});
		expect(() =>
			resolvePortPlan({
				root,
				projectPrefix: "fixture",
				projectName: "fixture",
				services: { postgres: { port: 5432 } },
				apps: { marketing: { port: 3000, devCommand: false } },
				probeNames: ["marketing"],
				getOwner: () => ({ pids: [99999], command: "foreign", cwd: "/other" }),
			}),
		).toThrow("persisted allocation: port 3100 held by process 99999");
		expect(readPortsLockfile(root)?.ports.postgres).toBe(5532);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("offset claims", () => {
	const plan = (root: string, projectName = "lullu-a") =>
		resolvePortPlan({
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
			rmSync(join(second, ".buncargo"), { recursive: true, force: true });
			expect(plan(second, "lullu-b").offset).toBe(a.offset);
		} finally {
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("gives parallel suffixed environments their own offsets and keeps them, apart from dev's claim", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		// Two CI runners whose project names differ but hash the same.
		const first = mkdtempSync(join(tmpdir(), "buncargo-runner-1-"));
		const second = mkdtempSync(join(tmpdir(), "buncargo-runner-2-"));
		const suffixed = (root: string, read = false) =>
			resolvePortPlan({
				projectPrefix: "lullu",
				projectName: `lullu-${root === first ? "1" : "2"}-app-ci`,
				root,
				suffix: "ci",
				services: { postgres: { port: 5432 } },
				persist: false,
				...(read ? { probeConflicts: false } : { claim: true }),
				getOwner: () => null,
			});
		try {
			// Nothing is listening yet: the claim alone separates them.
			const a = suffixed(first);
			const b = suffixed(second);
			expect(b.offset).toBe(a.offset + PORT_OFFSET_STEP);

			expect(suffixed(second).offset).toBe(b.offset);
			expect(suffixed(first).offset).toBe(a.offset);
			expect(suffixed(second, true).offset).toBe(b.offset);
			expect(readPortsLockfile(second)).toBeNull();

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
			expect(readPortsLockfile(second)).toBeNull();
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
			resolvePortPlan({
				projectPrefix: "lullu",
				projectName: "lullu-app-ci",
				root,
				suffix: "ci",
				services: { postgres: { port: 5432 } },
				persist: false,
				claim: true,
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
			options: Partial<Parameters<typeof resolvePortPlan>[0]> = {},
		) =>
			resolvePortPlan({
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
				shared(second, { persist: false, probeConflicts: false }),
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

	it("reports claims whose blocks overlap through different offsets, and a port-less claim by its lockfile", async () => {
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
			// Claimed before claims recorded ports; its lockfile has them.
			const claims = JSON.parse(
				await Bun.file(join(home, ".buncargo/offsets.json")).text(),
			);
			claims.claims[older] = {
				offset: 1200,
				projectName: "lullu-older",
				updatedAt: "2026-01-01T00:00:00.000Z",
			};
			await Bun.write(
				join(home, ".buncargo/offsets.json"),
				JSON.stringify(claims),
			);
			writePortsLockfile(older, {
				version: 1,
				projectName: "lullu-older",
				root: older,
				offset: 1200,
				ports: { postgres: 6532 },
				provenance: "hash",
			});

			expect(
				overlappingOffsetClaims(readOffsetClaimsWithPorts()).map(
					describeOffsetClaimOverlap,
				),
			).toEqual([
				`${api} (offset 1100) and ${admin} (offset 100) both claim port 4100`,
				`${api} (offset 1100) and ${older} (offset 1200) both claim port 6532`,
			]);
		} finally {
			for (const root of [api, admin, older, apart])
				rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports two claims on one offset even when neither recorded its ports", () => {
		expect(
			overlappingOffsetClaims({
				"/a": { offset: 300, projectName: "a", updatedAt: "" },
				"/b": { offset: 300, projectName: "b", updatedAt: "" },
				"/c": { offset: 400, projectName: "c", updatedAt: "" },
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
			resolvePortPlan({
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
			await Bun.write(
				join(first, ".buncargo/ports.json"),
				JSON.stringify({ offset: 200 }),
			);
			await Bun.write(
				join(second, ".buncargo/ports.json"),
				JSON.stringify({ offset: 100 }),
			);
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
			await Bun.write(
				join(first, ".buncargo/ports.json"),
				JSON.stringify({ offset: 200 }),
			);
			await Bun.write(
				join(second, ".buncargo/ports.json"),
				JSON.stringify({ offset: 100 }),
			);
			// Tailscale's listener on the first checkout's own HTTPS port fails
			// the bind probe, exactly as a stranger would.
			const a = resolvePortPlan({
				projectPrefix: "lullu",
				projectName: "lullu-a",
				root: first,
				services: {},
				apps: { web: { port: 5173, devCommand: "true" } },
				getOwner: (port) =>
					port === 25373 ? { pids: [], unidentified: true } : null,
				companionPorts: (ports) =>
					ports.web === undefined ? [] : [ports.web + 20_000],
			});
			expect(a.offset).toBe(200);
			expect(readOffsetClaims()[first]?.ports).toEqual([5373, 25373]);

			// 25273 at offset 100 is the first checkout's HTTPS port.
			const b = resolvePortPlan({
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
		const apps: Record<string, AppConfig> = {
			firebase: { port: 4000, extraPorts: [9099, 9199], devCommand: "true" },
		};
		try {
			await Bun.write(
				join(first, ".buncargo/ports.json"),
				JSON.stringify({ offset: 100 }),
			);
			await Bun.write(
				join(second, ".buncargo/ports.json"),
				JSON.stringify({ offset: 0 }),
			);
			const a = resolvePortPlan({
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
			const b = resolvePortPlan({
				projectPrefix: "fb",
				projectName: "fb-b",
				root: second,
				services: {},
				apps,
				getOwner: () => null,
			});
			expect(b.offset).not.toBe(0);

			// And a stranger on an extra port moves the block too.
			const third = resolvePortPlan({
				projectPrefix: "fb",
				projectName: "fb-c",
				root: second,
				services: {},
				apps,
				getOwner: (port) =>
					port === 9099 + b.offset
						? { pids: [99999], command: "java", cwd: "/elsewhere" }
						: null,
			});
			expect(third.offset).not.toBe(b.offset);
		} finally {
			console.warn = warn;
			rmSync(first, { recursive: true, force: true });
			rmSync(second, { recursive: true, force: true });
		}
	});

	it("keeps honouring a claim written without its ports by its offset", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const older = mkdtempSync(join(tmpdir(), "buncargo-older-"));
		const root = mkdtempSync(join(tmpdir(), "buncargo-newer-"));
		try {
			const hashed = computeBaseOffset({ projectPrefix: "lullu" });
			await Bun.write(
				join(home, ".buncargo/offsets.json"),
				JSON.stringify({
					version: 1,
					claims: {
						[older]: {
							offset: hashed,
							projectName: "lullu-old",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					},
				}),
			);
			expect(plan(root).offset).toBe(hashed + PORT_OFFSET_STEP);
			expect(readOffsetClaims()).toMatchObject({
				[older]: { offset: hashed },
				[root]: {
					offset: hashed + PORT_OFFSET_STEP,
					ports: [5432 + hashed + PORT_OFFSET_STEP],
				},
			});
		} finally {
			rmSync(older, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps an incumbent whose claim has no ports in the block its lockfile records", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		// b holds offset 1100 (4100, 5100) under a claim from before claims had
		// ports; a's offset 100 would be 3100 and 4100.
		const incumbent = mkdtempSync(join(tmpdir(), "buncargo-incumbent-"));
		const newcomer = mkdtempSync(join(tmpdir(), "buncargo-newcomer-"));
		const services = { api: { port: 3000 }, admin: { port: 4000 } };
		const blocks = (root: string, projectName: string) =>
			resolvePortPlan({
				projectPrefix: "lullu",
				projectName,
				root,
				services,
				getOwner: () => null,
			});
		const warn = console.warn;
		console.warn = () => {};
		try {
			writePortsLockfile(incumbent, {
				version: 1,
				projectName: "lullu-b",
				root: incumbent,
				offset: 1100,
				ports: { api: 4100, admin: 5100 },
				provenance: "hash",
			});
			await Bun.write(
				join(home, ".buncargo/offsets.json"),
				JSON.stringify({
					version: 1,
					claims: {
						[incumbent]: {
							offset: 1100,
							projectName: "lullu-b",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					},
				}),
			);
			await Bun.write(
				join(newcomer, ".buncargo/ports.json"),
				JSON.stringify({ offset: 100 }),
			);

			const a = blocks(newcomer, "lullu-a");
			expect(Object.values(a.ports)).not.toContain(4100);
			expect(blocks(incumbent, "lullu-b").offset).toBe(1100);
		} finally {
			console.warn = warn;
			rmSync(incumbent, { recursive: true, force: true });
			rmSync(newcomer, { recursive: true, force: true });
		}
	});

	it("refuses a partial start whose persisted block another checkout now claims", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-partial-claim-"));
		const other = mkdtempSync(join(tmpdir(), "buncargo-partial-other-"));
		try {
			writePortsLockfile(root, {
				version: 1,
				projectName: "lullu-a",
				root,
				offset: 100,
				ports: { postgres: 5532, marketing: 3100 },
				provenance: "hash",
			});
			withOffsetClaimsLock(() =>
				claimOffset({
					root: other,
					offset: 1100,
					ports: [3100],
					projectName: "lullu-b",
				}),
			);
			expect(() =>
				resolvePortPlan({
					root,
					projectPrefix: "lullu",
					projectName: "lullu-a",
					services: { postgres: { port: 5432 } },
					apps: { marketing: { port: 3000, devCommand: false } },
					probeNames: ["marketing"],
					getOwner: () => null,
				}),
			).toThrow(
				`persisted allocation: port 3100 is in the block ${other} claims`,
			);
			expect(readPortsLockfile(root)?.offset).toBe(100);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("pins a checkout with an offset-only lockfile and fills in the rest", async () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-pin-"));
		try {
			await Bun.write(
				join(root, ".buncargo/ports.json"),
				JSON.stringify({ offset: 2500 }),
			);
			const pinned = plan(root);
			expect(pinned).toMatchObject({
				offset: 2500,
				provenance: "lockfile",
				ports: { postgres: 7932 },
			});
			expect(readPortsLockfile(root)).toMatchObject({
				offset: 2500,
				root,
				ports: { postgres: 7932 },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("says why a lockfile is not used", () => {
		delete process.env.BUNCARGO_PORT_OFFSET;
		const root = mkdtempSync(join(tmpdir(), "buncargo-copied-"));
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: string) => warnings.push(String(message));
		try {
			writePortsLockfile(root, {
				version: 1,
				projectName: "lullu-a",
				root: "/somewhere/else",
				offset: 2500,
				ports: {},
				provenance: "lockfile",
			});
			const allocated = plan(root);
			expect(allocated.offset).not.toBe(2500);
			expect(warnings.join("\n")).toContain(
				"not used: it was written for /somewhere/else",
			);
		} finally {
			console.warn = warn;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("pinOffset", () => {
	const services = { postgres: { port: 5432 } };

	it("writes the lockfile and claims the block", () => {
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
			expect(readPortsLockfile(root)).toMatchObject({ offset: 2500, root });
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
				resolvePortPlan({
					projectPrefix: "lullu",
					projectName: "lullu-a",
					root,
					services,
					getOwner: () => null,
				}),
			).toThrow("refused" in result ? result.refused : "");
			expect(readPortsLockfile(root)).toBeNull();
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
			expect(readPortsLockfile(root)).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(other, { recursive: true, force: true });
		}
	});
});
