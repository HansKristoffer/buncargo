import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

afterEach(() => {
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
});
