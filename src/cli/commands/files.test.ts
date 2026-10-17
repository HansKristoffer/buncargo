import { afterEach, beforeEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CI_ENV_VARS } from "../../core/runtime-flags";

const cli = resolve(import.meta.dir, "../bin.ts");
let dir: string;

/** A checkout of github.com/acme/app with its own HOME. */
function checkout(name: string): string {
	const root = join(dir, name);
	mkdirSync(root);
	spawnSync("git", ["init", "-q"], { cwd: root });
	spawnSync("git", ["remote", "add", "origin", "git@github.com:Acme/App.git"], {
		cwd: root,
	});
	writeFileSync(join(root, ".gitignore"), ".env*\n.buncargo/\n");
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default { projectPrefix: "files", services: {}, options: { checkoutFiles: [".env.local", { path: ".env.machine", machine: true }] } };`,
	);
	return root;
}

function files(root: string, home: string, args: string[], stdin?: string) {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
	};
	for (const name of CI_ENV_VARS) delete env[name];
	const result = spawnSync(process.execPath, [cli, "files", ...args], {
		cwd: root,
		env,
		encoding: "utf-8",
		input: stdin,
	});
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-files-cli-")));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

it("reports status in the shape agentgate reads", () => {
	const root = checkout("app");
	writeFileSync(join(root, ".env.local"), "A=1\n");
	const { code, stdout } = files(root, join(dir, "home"), ["status", "--json"]);
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toEqual({
		version: 1,
		repoKey: "github.com/acme/app",
		files: [
			{ path: ".env.local", state: "local-edits", machine: false },
			{ path: ".env.machine", state: "missing", machine: true },
		],
	});
});

it("moves files to another machine with export and import, never machine ones", () => {
	const laptop = checkout("laptop");
	writeFileSync(join(laptop, ".env.local"), "A=1\n");
	writeFileSync(join(laptop, ".env.machine"), "M=laptop\n");
	const exported = files(laptop, join(dir, "laptop-home"), ["export"]);
	expect(exported.code).toBe(0);
	expect(exported.stdout).not.toContain('machine":true');

	const server = checkout("server");
	const imported = files(
		server,
		join(dir, "server-home"),
		["import"],
		exported.stdout,
	);
	expect(imported.code).toBe(0);
	expect(readFileSync(join(server, ".env.local"), "utf8")).toBe("A=1\n");
	expect(() => readFileSync(join(server, ".env.machine"))).toThrow();
});

it("exits 1 from pull when local edits are left, and 0 once forced", () => {
	const root = checkout("app");
	const home = join(dir, "home");
	writeFileSync(join(root, ".env.local"), "A=1\n");
	expect(files(root, home, ["pull"]).code).toBe(0);
	writeFileSync(join(root, ".env.local"), "A=mine\n");
	expect(files(root, home, ["pull", ".env.local"]).code).toBe(1);
	expect(files(root, home, ["pull", "--force", ".env.local"]).code).toBe(0);
	expect(readFileSync(join(root, ".env.local"), "utf8")).toBe("A=1\n");
});

it("diffs keys without printing values", () => {
	const root = checkout("app");
	const home = join(dir, "home");
	writeFileSync(join(root, ".env.local"), "A=1\nSECRET=one\n");
	files(root, home, ["save"]);
	writeFileSync(join(root, ".env.local"), "A=1\nSECRET=two\nNEW=x\n");
	const { stdout } = files(root, home, ["diff", ".env.local"]);
	expect(stdout).toContain("~ SECRET");
	expect(stdout).toContain("+ NEW");
	expect(stdout).not.toContain("two");

	const unknown = files(root, home, ["diff", ".env.nope"]);
	expect(unknown.code).toBe(1);
	expect(unknown.stderr).toContain(
		".env.nope is not in options.checkoutFiles (.env.local, .env.machine)",
	);
});

it("merges key by key, asking for conflicting keys by name only", () => {
	const root = checkout("app");
	const home = join(dir, "home");
	writeFileSync(join(root, ".env.local"), "A=1\nSECRET=one\n");
	files(root, home, ["save"]);
	const other = checkout("other");
	files(other, home, ["pull"]);
	writeFileSync(join(other, ".env.local"), "A=1\nSECRET=stored\nNEW=x\n");
	files(other, home, ["save"]);
	writeFileSync(join(root, ".env.local"), "A=2\nSECRET=mine\n");

	const status = files(root, home, ["status"]);
	expect(status.stdout).toContain("buncargo files merge .env.local");
	expect(status.stdout).not.toMatch(/stored|mine/);

	const stopped = files(root, home, ["merge", ".env.local"]);
	expect(stopped.code).toBe(1);
	expect(stopped.stderr).toContain("--checkout=SECRET");
	expect(stopped.stdout + stopped.stderr).not.toMatch(/stored|mine/);

	const merged = files(root, home, ["merge", ".env.local", "--store=SECRET"]);
	expect(merged.code).toBe(0);
	expect(readFileSync(join(root, ".env.local"), "utf8")).toBe(
		"A=2\nSECRET=stored\nNEW=x\n",
	);
	expect(files(other, home, ["pull"]).code).toBe(0);
	expect(readFileSync(join(other, ".env.local"), "utf8")).toBe(
		"A=2\nSECRET=stored\nNEW=x\n",
	);
});
