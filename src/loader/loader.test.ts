import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineDevConfig } from "../config";
import { service } from "../docker-compose/services";
import {
	CONFIG_FILES,
	clearDevEnvCache,
	findConfigFile,
	getDevEnv,
	loadDevEnv,
} from ".";

// ═══════════════════════════════════════════════════════════════════════════
// findConfigFile Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("findConfigFile", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temp directory for each test
		testDir = join(tmpdir(), `buncargo-test-${Date.now()}-${Math.random()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up temp directory
		rmSync(testDir, { recursive: true, force: true });
	});

	it("finds config file in the current directory", () => {
		const configPath = join(testDir, "dev.config.ts");
		writeFileSync(configPath, "export default {}");

		const result = findConfigFile(testDir);

		expect(result).toBe(configPath);
	});

	it("finds config file in parent directory", () => {
		const subDir = join(testDir, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		const configPath = join(testDir, "dev.config.ts");
		writeFileSync(configPath, "export default {}");

		const result = findConfigFile(subDir);

		expect(result).toBe(configPath);
	});

	it("finds config file multiple levels up", () => {
		const deepDir = join(testDir, "packages", "apps", "web", "src");
		mkdirSync(deepDir, { recursive: true });

		const configPath = join(testDir, "dev.config.ts");
		writeFileSync(configPath, "export default {}");

		const result = findConfigFile(deepDir);

		expect(result).toBe(configPath);
	});

	it("prefers config in current directory over parent", () => {
		const subDir = join(testDir, "packages", "app");
		mkdirSync(subDir, { recursive: true });

		// Config in root
		writeFileSync(join(testDir, "dev.config.ts"), "export default {}");
		// Config in subdirectory
		const subConfigPath = join(subDir, "dev.config.ts");
		writeFileSync(subConfigPath, "export default {}");

		const result = findConfigFile(subDir);

		expect(result).toBe(subConfigPath);
	});

	it("returns null when no config file exists", () => {
		const result = findConfigFile(testDir);

		expect(result).toBeNull();
	});

	it("finds dev.config.js when dev.config.ts is missing", () => {
		const configPath = join(testDir, "dev.config.js");
		writeFileSync(configPath, "module.exports = {}");

		const result = findConfigFile(testDir);

		expect(result).toBe(configPath);
	});

	it("finds dev-tools.config.ts as alternative name", () => {
		const configPath = join(testDir, "dev-tools.config.ts");
		writeFileSync(configPath, "export default {}");

		const result = findConfigFile(testDir);

		expect(result).toBe(configPath);
	});

	it("prefers dev.config.ts over dev.config.js", () => {
		writeFileSync(join(testDir, "dev.config.js"), "module.exports = {}");
		const tsConfigPath = join(testDir, "dev.config.ts");
		writeFileSync(tsConfigPath, "export default {}");

		const result = findConfigFile(testDir);

		expect(result).toBe(tsConfigPath);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG_FILES Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("CONFIG_FILES", () => {
	it("contains expected config file names", () => {
		expect(CONFIG_FILES).toContain("dev.config.ts");
		expect(CONFIG_FILES).toContain("dev.config.js");
		expect(CONFIG_FILES).toContain("dev-tools.config.ts");
		expect(CONFIG_FILES).toContain("dev-tools.config.js");
	});

	it("has .ts files before .js files for priority", () => {
		const tsIndex = CONFIG_FILES.indexOf("dev.config.ts");
		const jsIndex = CONFIG_FILES.indexOf("dev.config.js");

		expect(tsIndex).toBeLessThan(jsIndex);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// getDevEnv / clearDevEnvCache Tests
// ═══════════════════════════════════════════════════════════════════════════

describe("getDevEnv", () => {
	afterEach(() => {
		clearDevEnvCache();
	});

	it("throws when environment not loaded", () => {
		expect(() => getDevEnv()).toThrow(
			"Dev environment not loaded. Call loadDevEnv() first.",
		);
	});
});

describe("clearDevEnvCache", () => {
	it("clears the cached environment", () => {
		// After clearing, getDevEnv should throw
		clearDevEnvCache();

		expect(() => getDevEnv()).toThrow();
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// loadDevEnv Tests
// ═══════════════════════════════════════════════════════════════════════════

const typedConfig = defineDevConfig({
	projectPrefix: "loader-typing",
	services: {
		db: service.postgres({ port: 5432 }),
	},
	apps: {
		api: { port: 3000, devCommand: "bun run dev" },
	},
});

describe("loadDevEnv", () => {
	let testDir: string;
	const originalOffset = process.env.BUNCARGO_PORT_OFFSET;

	beforeEach(() => {
		testDir = join(tmpdir(), `buncargo-loader-${Date.now()}-${Math.random()}`);
		mkdirSync(testDir, { recursive: true });
		// A fixed offset, because the allocator resolves its root from the
		// process cwd rather than the config path: without this these tests
		// probe every port on the machine and persist a `.buncargo/ports.json`
		// into the buncargo checkout itself.
		process.env.BUNCARGO_PORT_OFFSET = "0";
		clearDevEnvCache();
	});

	afterEach(() => {
		clearDevEnvCache();
		if (originalOffset === undefined) {
			delete process.env.BUNCARGO_PORT_OFFSET;
		} else {
			process.env.BUNCARGO_PORT_OFFSET = originalOffset;
		}
		rmSync(testDir, { recursive: true, force: true });
	});

	it("keeps config inference when the config type is passed", async () => {
		writeFileSync(
			join(testDir, "dev.config.ts"),
			`export default ${JSON.stringify(typedConfig)}`,
		);

		const env = await loadDevEnv<typeof typedConfig>({ cwd: testDir });

		// Type-level: these read as typed keys, not index lookups.
		const apiUrl: string = env.urls.api;
		const apiPort: number = env.ports.api;
		expect(apiUrl).toBe(`http://localhost:${apiPort}`);

		// @ts-expect-error - "missing" is not a configured app or service
		expect(env.urls.missing).toBeUndefined();
	});

	it("returns the same typed environment from getDevEnv", async () => {
		writeFileSync(
			join(testDir, "dev.config.ts"),
			`export default ${JSON.stringify(typedConfig)}`,
		);

		const loaded = await loadDevEnv<typeof typedConfig>({ cwd: testDir });
		const fetched = getDevEnv<typeof typedConfig>();

		expect(fetched).toBe(loaded);
		const apiUrl: string = fetched.urls.api;
		expect(apiUrl).toBe(loaded.urls.api);
	});

	it("throws when no config file exists", async () => {
		await expect(loadDevEnv({ cwd: testDir })).rejects.toThrow(
			"No config file found",
		);
	});

	it("throws when the config has no default export", async () => {
		writeFileSync(join(testDir, "dev.config.ts"), "export const nope = {};");

		await expect(loadDevEnv({ cwd: testDir })).rejects.toThrow(
			"Use defineDevConfig() and export as default",
		);
	});
});
