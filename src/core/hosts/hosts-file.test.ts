import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyHostsBlock,
	buildHostsBlock,
	extractManagedBlock,
	HOSTS_BLOCK_END,
	HOSTS_BLOCK_START,
	readManagedHostnames,
	syncHostsFile,
} from "./hosts-file";

describe("hosts file block", () => {
	it("builds an idempotent marked block", () => {
		const block = buildHostsBlock([
			"api.serpier.localhost",
			"serpier.localhost",
		]);
		expect(block.startsWith(HOSTS_BLOCK_START)).toBe(true);
		expect(block.endsWith(HOSTS_BLOCK_END)).toBe(true);
		expect(block).toContain("127.0.0.1 api.serpier.localhost");
		expect(block).toContain("::1 serpier.localhost");
	});

	it("replaces an existing block without duplicating", () => {
		const first = applyHostsBlock("127.0.0.1 localhost\n", ["a.localhost"]);
		const second = applyHostsBlock(first, ["b.localhost"]);
		expect(second.match(/buncargo-start/g)?.length).toBe(1);
		expect(second).toContain("b.localhost");
		expect(second).not.toContain("a.localhost");
		expect(second).toContain("127.0.0.1 localhost");
	});

	it("removes the block when the hostname list is empty", () => {
		const withBlock = applyHostsBlock("127.0.0.1 localhost\n", ["a.localhost"]);
		const cleaned = applyHostsBlock(withBlock, []);
		expect(cleaned).not.toContain(HOSTS_BLOCK_START);
		expect(cleaned).toContain("127.0.0.1 localhost");
	});

	it("reads managed hostnames from a block", () => {
		const contents = applyHostsBlock("", ["api.localhost", "web.localhost"]);
		expect(readManagedHostnames(contents).sort()).toEqual([
			"api.localhost",
			"web.localhost",
		]);
	});

	it("extracts nothing when no block exists", () => {
		expect(extractManagedBlock("127.0.0.1 localhost\n").block).toBeNull();
	});
});

/**
 * Every name resolution on the machine reads this file, including the
 * `localhost` entry the system itself depends on, so it must never be
 * observable half-written.
 */
describe("syncHostsFile", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function hostsFile(contents = "127.0.0.1 localhost\n"): string {
		const dir = mkdtempSync(join(tmpdir(), "buncargo-hostsfile-"));
		dirs.push(dir);
		const path = join(dir, "hosts");
		writeFileSync(path, contents, { mode: 0o644 });
		return path;
	}

	it("writes the managed block and leaves existing entries alone", () => {
		const path = hostsFile();
		syncHostsFile(["web.demo.localhost"], path);
		const contents = readFileSync(path, "utf-8");
		expect(contents).toContain("127.0.0.1 localhost");
		expect(contents).toContain("127.0.0.1 web.demo.localhost");
	});

	it("keeps the file's mode, so a rename cannot make it unreadable", () => {
		const path = hostsFile();
		syncHostsFile(["web.demo.localhost"], path);
		expect(statSync(path).mode & 0o777).toBe(0o644);
	});

	it("leaves no temp file behind", () => {
		const path = hostsFile();
		syncHostsFile(["web.demo.localhost"], path);
		const entries = readdirSync(join(path, ".."));
		expect(entries).toEqual(["hosts"]);
	});

	it("does not rewrite the file when nothing changed", () => {
		const path = hostsFile();
		syncHostsFile(["web.demo.localhost"], path);
		const before = statSync(path).mtimeMs;
		syncHostsFile(["web.demo.localhost"], path);
		expect(statSync(path).mtimeMs).toBe(before);
	});

	it("removes the block when the last route goes away", () => {
		const path = hostsFile();
		syncHostsFile(["web.demo.localhost"], path);
		syncHostsFile([], path);
		const contents = readFileSync(path, "utf-8");
		expect(contents).toContain("127.0.0.1 localhost");
		expect(contents).not.toContain(HOSTS_BLOCK_START);
	});
});
