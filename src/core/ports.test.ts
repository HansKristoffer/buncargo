import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig, ServiceConfig } from "../types";
import { applyHostPlanToUrls } from "./hosts/plan";
import {
	computeDevIdentity,
	computeLoopbackUrls,
	computeUrls,
	getProjectName,
	getWorktreeProjectSuffix,
} from "./ports";

// ═══════════════════════════════════════════════════════════════════════════
// computeUrls Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("computeUrls", () => {
	const localIp = "192.168.1.100";

	it("uses default URL builder for postgres", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432 },
		};
		const ports = { postgres: 5432 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.postgres).toBe(
			"postgresql://postgres:postgres@localhost:5432/postgres",
		);
	});

	it("uses default URL builder for redis", () => {
		const services: Record<string, ServiceConfig> = {
			redis: { port: 6379 },
		};
		const ports = { redis: 6379 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.redis).toBe("redis://localhost:6379");
	});

	it("uses default URL builder for clickhouse", () => {
		const services: Record<string, ServiceConfig> = {
			clickhouse: { port: 8123 },
		};
		const ports = { clickhouse: 8123 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.clickhouse).toBe(
			"http://default:clickhouse@localhost:8123/default",
		);
	});

	it("uses default URL builder for mysql", () => {
		const services: Record<string, ServiceConfig> = {
			mysql: { port: 3306 },
		};
		const ports = { mysql: 3306 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.mysql).toBe("mysql://root:root@localhost:3306/mysql");
	});

	it("uses default URL builder for mongodb", () => {
		const services: Record<string, ServiceConfig> = {
			mongodb: { port: 27017 },
		};
		const ports = { mongodb: 27017 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.mongodb).toBe("mongodb://localhost:27017");
	});

	it("uses custom urlTemplate when provided", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: {
				port: 5432,
				urlTemplate: ({ port, host }) =>
					`postgresql://custom:password@${host}:${port}/mydb`,
			},
		};
		const ports = { postgres: 5432 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.postgres).toBe(
			"postgresql://custom:password@localhost:5432/mydb",
		);
	});

	it("passes localIp to custom urlTemplate", () => {
		const services: Record<string, ServiceConfig> = {
			api: {
				port: 3000,
				urlTemplate: ({ port, localIp }) => `http://${localIp}:${port}`,
			},
		};
		const ports = { api: 3000 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.api).toBe("http://192.168.1.100:3000");
	});

	it("passes secondaryPort to custom urlTemplate", () => {
		const services: Record<string, ServiceConfig> = {
			clickhouse: {
				port: 8123,
				secondaryPort: 9000,
				urlTemplate: ({ port, secondaryPort }) =>
					`http://localhost:${port}|native:${secondaryPort}`,
			},
		};
		const ports = { clickhouse: 8123, clickhouseSecondary: 9000 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.clickhouse).toBe("http://localhost:8123|native:9000");
	});

	it("falls back to http URL for unknown services", () => {
		const services: Record<string, ServiceConfig> = {
			customservice: { port: 9999 },
		};
		const ports = { customservice: 9999 };

		const result = computeUrls(services, undefined, ports, localIp);

		expect(result.customservice).toBe("http://localhost:9999");
	});

	it("generates app URLs with http://localhost:port", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432 },
		};
		const apps: Record<string, AppConfig> = {
			api: { port: 3000, devCommand: "bun run dev" },
		};
		const ports = { postgres: 5432, api: 3000 };

		const result = computeUrls(services, apps, ports, localIp);

		expect(result.api).toBe("http://localhost:3000");
	});

	it("generates appLocal URLs with local IP", () => {
		const services: Record<string, ServiceConfig> = {};
		const apps: Record<string, AppConfig> = {
			api: { port: 3000, devCommand: "bun run dev" },
			web: { port: 5173, devCommand: "bun run dev:web" },
		};
		const ports = { api: 3000, web: 5173 };

		const result = computeUrls(services, apps, ports, localIp);

		expect(result.apiLocal).toBe("http://192.168.1.100:3000");
		expect(result.webLocal).toBe("http://192.168.1.100:5173");
	});

	it("leaves named-host rewriting to applyHostPlanToUrls", () => {
		const services: Record<string, ServiceConfig> = {
			postgres: { port: 5432 },
			mailpit: { port: 8025 },
		};
		const apps: Record<string, AppConfig> = {
			api: { port: 3000, devCommand: "bun run dev" },
		};
		const ports = { postgres: 5432, mailpit: 8025, api: 3000 };

		const result = computeUrls(services, apps, ports, localIp);
		expect(result.api).toBe("http://localhost:3000");

		applyHostPlanToUrls(result, [
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				targetPort: 3000,
			},
			{
				kind: "service",
				name: "mailpit",
				hostname: "mailpit.serpier.localhost",
				targetPort: 8025,
			},
		]);

		expect(result.api).toBe("https://api.serpier.localhost");
		expect(result.mailpit).toBe("https://mailpit.serpier.localhost");
		expect(result.apiLocal).toBe("http://192.168.1.100:3000");
		expect(result.postgres).toMatch(/^postgresql:\/\//);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// computeLoopbackUrls Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("computeLoopbackUrls", () => {
	const services: Record<string, ServiceConfig> = {
		postgres: { port: 5432 },
		mailpit: { port: 8025 },
	};
	const apps: Record<string, AppConfig> = {
		api: { port: 3000, devCommand: "bun run dev" },
	};
	const ports = { postgres: 5432, mailpit: 8025, api: 3000 };

	it("addresses every service and app through localhost", () => {
		const result = computeLoopbackUrls(services, apps, ports);

		expect(result.api).toBe("http://localhost:3000");
		expect(result.mailpit).toBe("http://localhost:8025");
		expect(result.postgres).toBe(
			"postgresql://postgres:postgres@localhost:5432/postgres",
		);
	});

	// The LAN IP is a different address for a different purpose (mobile
	// devices), so folding it in here would conflate the two.
	it("omits the <app>Local LAN aliases", () => {
		expect(computeLoopbackUrls(services, apps, ports)).not.toHaveProperty(
			"apiLocal",
		);
	});

	// The whole point: `applyHostPlanToUrls` rewrites the main map in place, and
	// consumers that do not trust the local CA need what it overwrote.
	it("survives a named-host rewrite of the main URL map", () => {
		const urls = computeUrls(services, apps, ports, "192.168.1.100");
		const loopback = computeLoopbackUrls(services, apps, ports);

		applyHostPlanToUrls(urls, [
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				targetPort: 3000,
			},
		]);

		expect(urls.api).toBe("https://api.serpier.localhost");
		expect(loopback.api).toBe("http://localhost:3000");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// getProjectName Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("getProjectName", () => {
	it("generates project name from prefix and directory", () => {
		// Using a known directory path for testing
		const result = getProjectName("myapp", undefined, "/home/user/myproject");

		expect(result).toBe("myapp-myproject");
	});

	it("handles suffix correctly", () => {
		const result = getProjectName("myapp", "test", "/home/user/myproject");

		expect(result).toBe("myapp-myproject-test");
	});

	it("sanitizes special characters in directory names", () => {
		const result = getProjectName(
			"myapp",
			undefined,
			"/home/user/My_Project.Name",
		);

		expect(result).toBe("myapp-my-project-name");
	});

	it("converts uppercase to lowercase", () => {
		const result = getProjectName("myapp", undefined, "/home/user/MyProject");

		expect(result).toBe("myapp-myproject");
	});

	it("preserves hyphens in directory name", () => {
		const result = getProjectName("myapp", undefined, "/home/user/my-project");

		expect(result).toBe("myapp-my-project");
	});

	it("replaces underscores with hyphens", () => {
		const result = getProjectName("myapp", undefined, "/home/user/my_project");

		expect(result).toBe("myapp-my-project");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// getWorktreeProjectSuffix Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("getWorktreeProjectSuffix", () => {
	it("returns null outside worktree", () => {
		const result = getWorktreeProjectSuffix("/tmp/does-not-exist");
		expect(result).toBeNull();
	});

	it("returns sanitized suffix from worktree name", () => {
		const testDir = join(tmpdir(), `buncargo-worktree-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		try {
			writeFileSync(
				join(testDir, ".git"),
				"gitdir: /tmp/repo/worktrees/Feature_Branch.1",
			);
			const result = getWorktreeProjectSuffix(testDir);
			expect(result).toBe("feature-branch-1");
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// computeDevIdentity Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("computeDevIdentity", () => {
	it("includes worktree suffix in project name by default", () => {
		const testDir = join(tmpdir(), `buncargo-identity-test-${Date.now()}-1`);
		mkdirSync(testDir, { recursive: true });
		try {
			writeFileSync(
				join(testDir, ".git"),
				"gitdir: /tmp/repo/worktrees/Feature_A",
			);
			const identity = computeDevIdentity({
				projectPrefix: "myapp",
				root: testDir,
			});
			expect(identity.worktree).toBe(true);
			expect(identity.worktreeSuffix).toBe("feature-a");
			expect(identity.projectSuffix).toBe("feature-a");
			expect(identity.projectName).toBe(
				getProjectName("myapp", "feature-a", testDir),
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("omits worktree suffix when isolation is disabled", () => {
		const testDir = join(tmpdir(), `buncargo-identity-test-${Date.now()}-2`);
		mkdirSync(testDir, { recursive: true });
		try {
			writeFileSync(
				join(testDir, ".git"),
				"gitdir: /tmp/repo/worktrees/Feature_A",
			);
			const identity = computeDevIdentity({
				projectPrefix: "myapp",
				root: testDir,
				worktreeIsolation: false,
			});
			expect(identity.worktree).toBe(true);
			expect(identity.worktreeSuffix).toBeNull();
			expect(identity.projectSuffix).toBeUndefined();
			expect(identity.projectName).toBe(
				getProjectName("myapp", undefined, testDir),
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("composes explicit suffix with worktree suffix in stable order", () => {
		const testDir = join(tmpdir(), `buncargo-identity-test-${Date.now()}-3`);
		mkdirSync(testDir, { recursive: true });
		try {
			writeFileSync(
				join(testDir, ".git"),
				"gitdir: /tmp/repo/worktrees/Feature_A",
			);
			const identity = computeDevIdentity({
				projectPrefix: "myapp",
				root: testDir,
				suffix: "test",
			});
			expect(identity.projectSuffix).toBe("test-feature-a");
			expect(identity.projectName).toBe(
				getProjectName("myapp", "test-feature-a", testDir),
			);
		} finally {
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
