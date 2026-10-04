import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerRuntimeAdapter } from "../container-runtime/types";
import type { AppConfig, ServiceConfig } from "../types";
import {
	buildPortMap,
	computeBaseOffset,
	PORT_OFFSET_STEP,
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
		).toThrow("persisted allocation");
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
