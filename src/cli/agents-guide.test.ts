import { describe, expect, it } from "bun:test";
import { AGENTS_BLOCK, upsertAgentsBlock } from "./agents-guide";

describe("upsertAgentsBlock", () => {
	it("appends to an AGENTS.md without one, and replaces it in place after", () => {
		const first = upsertAgentsBlock("# Project\n\nRules.\n");
		expect(first).toBe(`# Project\n\nRules.\n\n${AGENTS_BLOCK}\n`);

		const edited = first.replace("## Dev environment", "## Old heading");
		const again = upsertAgentsBlock(`${edited}\nAfter.\n`);
		expect(again).toBe(`# Project\n\nRules.\n\n${AGENTS_BLOCK}\n\nAfter.\n`);
		expect(upsertAgentsBlock(again)).toBe(again);
	});

	it("creates the file's content from nothing", () => {
		expect(upsertAgentsBlock("")).toBe(`${AGENTS_BLOCK}\n`);
	});
});
