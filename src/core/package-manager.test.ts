import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	detectPackageManager,
	findLockfile,
	matchesNodeVersion,
	parseNodeVersionOutput,
	parsePackageManagerField,
	parsePinnedNodeVersion,
	parsePnpmWorkspacePackages,
	readPinnedNodeVersion,
	readPnpmWorkspacePackages,
} from "./package-manager";
import { useTempHome } from "./test-env.testing";

const home = useTempHome();

function tempDir(prefix: string): string {
	return mkdtempSync(join(home(), `${prefix}-`));
}

describe("package manager detection", () => {
	it("detects package managers from lockfiles, pnpm-workspace.yaml, and packageManager", () => {
		const bunDir = tempDir("bun");
		writeFileSync(join(bunDir, "bun.lock"), "{}");
		expect(detectPackageManager(bunDir).name).toBe("bun");
		expect(detectPackageManager(bunDir).installCommand).toBe("bun install");
		expect(findLockfile(bunDir)?.name).toBe("bun.lock");

		const pnpmDir = tempDir("pnpm");
		writeFileSync(join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		const pnpm = detectPackageManager(pnpmDir);
		expect(pnpm.name).toBe("pnpm");
		expect(pnpm.installCommand).toBe("pnpm install");
		expect(pnpm.frozenInstallDisplay).toBe("pnpm install --frozen-lockfile");
		expect(pnpm.frozenInstallArgs()).toEqual([
			"pnpm",
			"install",
			"--frozen-lockfile",
		]);
		expect(pnpm.addDevCommand("firebase-tools")).toBe(
			"pnpm add -D firebase-tools",
		);
		expect(pnpm.runScriptArgs("typecheck")).toEqual([
			"pnpm",
			"run",
			"typecheck",
		]);

		const pnpmWorkspaceOnly = tempDir("pnpm-ws");
		writeFileSync(
			join(pnpmWorkspaceOnly, "pnpm-workspace.yaml"),
			"packages:\n  - apps/*\n",
		);
		expect(detectPackageManager(pnpmWorkspaceOnly).name).toBe("pnpm");

		const manifestOnly = tempDir("manifest");
		writeFileSync(
			join(manifestOnly, "package.json"),
			JSON.stringify({ packageManager: "yarn@4.5.0" }),
		);
		expect(detectPackageManager(manifestOnly).name).toBe("yarn");

		const npmDir = tempDir("npm");
		writeFileSync(join(npmDir, "package-lock.json"), "{}");
		const npm = detectPackageManager(npmDir);
		expect(npm.name).toBe("npm");
		expect(npm.frozenInstallArgs()).toEqual(["npm", "ci"]);

		const emptyDir = tempDir("empty");
		expect(detectPackageManager(emptyDir).name).toBe("bun");
	});

	it("parses packageManager field values safely", () => {
		expect(parsePackageManagerField("pnpm@10.12.4")).toBe("pnpm");
		expect(parsePackageManagerField("bun@1.4.4")).toBe("bun");
		expect(parsePackageManagerField("unknown@1.0.0")).toBeUndefined();
		expect(parsePackageManagerField(undefined)).toBeUndefined();
	});
});

describe("pnpm-workspace.yaml parsing", () => {
	it("extracts positive glob patterns from YAML list and inline array forms", () => {
		expect(
			parsePnpmWorkspacePackages(`
# comment
packages:
  - "apps/*"
# column-zero comment inside packages list
  - 'libs/*' # inline comment
  - packages/*
  - "!**/test/**"
onlyBuiltDependencies:
  - esbuild
`),
		).toEqual(["apps/*", "libs/*", "packages/*"]);

		expect(
			parsePnpmWorkspacePackages(
				`packages: ["core", "../packages/*", "!ignored"]`,
			),
		).toEqual(["core", "../packages/*"]);

		expect(parsePnpmWorkspacePackages("other:\n  - foo\n")).toBeUndefined();

		const dir = tempDir("read-pnpm-ws");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "pnpm-workspace.yaml"),
			"packages:\n  - apps/*\n  - libs/*\n",
		);
		expect(readPnpmWorkspacePackages(dir)).toEqual(["apps/*", "libs/*"]);
	});
});

describe("Node version pinning", () => {
	it("parses .nvmrc and .node-version and compares semver prefixes", () => {
		expect(parsePinnedNodeVersion("v22.21.0\n")).toBe("22.21.0");
		expect(parsePinnedNodeVersion("# comment\n24\n")).toBe("24");
		expect(parsePinnedNodeVersion("lts/*\n")).toBeUndefined();

		expect(matchesNodeVersion("22.21.1", "22")).toBe(true);
		expect(matchesNodeVersion("22.21.1", "22.21")).toBe(true);
		expect(matchesNodeVersion("22.21.1", "22.21.1")).toBe(true);
		expect(matchesNodeVersion("24.5.0", "22")).toBe(false);
		expect(parseNodeVersionOutput("v22.14.0\n")).toBe("22.14.0");

		const dir = tempDir("nvmrc");
		writeFileSync(join(dir, ".nvmrc"), "v22\n");
		expect(readPinnedNodeVersion(dir)).toEqual({
			version: "22",
			source: ".nvmrc",
		});
	});
});
