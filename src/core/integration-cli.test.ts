import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firebaseCli } from "../firebase/cli";
import { shopifyCli } from "../shopify/cli";
import { supabaseCli } from "../supabase/cli";
import { cliTool, publicEnvCopies } from "./integration-cli";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "buncargo-integration-cli-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function executable(path: string, script: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
	return path;
}

const projectBin = (dir: string, name: string) =>
	join(dir, "node_modules", ".bin", name);

describe("cliTool", () => {
	it("runs a project's own binary, the first directory's before the next, then PATH's", () => {
		const path = tempDir();
		const tool = cliTool({
			name: "tool",
			versionArgs: ["--version"],
			tested: { min: "1.0.0", below: "2.0.0" },
			env: () => ({ PATH: path }),
		});
		const [workdir, root] = [tempDir(), tempDir()];
		expect(tool.resolve([workdir, root])).toBe("tool");
		expect(tool.installed([workdir, root])).toBe(false);

		const global = executable(join(path, "tool"), "");
		expect(tool.resolve([workdir, root])).toBe(global);
		const rootBin = executable(projectBin(root, "tool"), "");
		expect(tool.resolve([workdir, root])).toBe(rootBin);
		const workdirBin = executable(projectBin(workdir, "tool"), "");
		expect(tool.resolve([workdir, root])).toBe(workdirBin);
		expect(tool.installed([workdir, root])).toBe(true);
	});

	it("reads the version with its own arguments and environment", () => {
		const dir = tempDir();
		const tool = cliTool({
			name: "tool",
			versionArgs: ["version"],
			tested: { min: "1.0.0", below: "2.0.0" },
			env: () => ({ ANSWER: "1.4.2" }),
		});
		const bin = executable(
			join(dir, "tool"),
			'[ "$1" = version ] && echo "tool/$ANSWER darwin-arm64"',
		);
		const version = tool.version(bin, dir);
		expect(version).toBe("1.4.2");
		expect(tool.isTested(version as string)).toBe(true);
		expect(tool.isTested("2.0.0")).toBe(false);

		const broken = executable(join(dir, "broken"), "echo 1.4.2; exit 1");
		expect(tool.version(broken, dir)).toBeUndefined();
		expect(tool.version(join(dir, "missing"), dir)).toBeUndefined();
	});

	it("finds Shopify's, Supabase's and Firebase's CLIs on PATH", () => {
		const path = tempDir();
		const saved = process.env.PATH;
		process.env.PATH = path;
		try {
			const root = tempDir();
			for (const [name, tool] of [
				["shopify", shopifyCli],
				["supabase", supabaseCli],
				["firebase", firebaseCli],
			] as const) {
				expect(tool.installed([root])).toBe(false);
				const bin = executable(join(path, name), "");
				expect(tool.resolve([root])).toBe(bin);
			}
		} finally {
			process.env.PATH = saved;
		}
	});
});

describe("publicEnvCopies", () => {
	it("copies each set value under every prefix", () => {
		const values = { URL: "http://api", KEY: "k", UNSET: undefined };
		expect(publicEnvCopies(values, ["VITE_", "EXPO_PUBLIC_"])).toEqual({
			VITE_URL: "http://api",
			VITE_KEY: "k",
			EXPO_PUBLIC_URL: "http://api",
			EXPO_PUBLIC_KEY: "k",
		});
		expect(publicEnvCopies(values, "NEXT_PUBLIC_")).toEqual({
			NEXT_PUBLIC_URL: "http://api",
			NEXT_PUBLIC_KEY: "k",
		});
		expect(publicEnvCopies(values, undefined)).toEqual({});
	});
});
