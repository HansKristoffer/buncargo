import { describe, expect, it } from "bun:test";
import {
	applyHostsBlock,
	buildHostsBlock,
	extractManagedBlock,
	HOSTS_BLOCK_END,
	HOSTS_BLOCK_START,
	readManagedHostnames,
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
