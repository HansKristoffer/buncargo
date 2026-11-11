import { describe, expect, it } from "bun:test";
import {
	AGENTS_BLOCK,
	AGENTS_GUIDE_TOPICS,
	agentsGuide,
	upsertAgentsBlock,
} from "./agents-guide";

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

describe("agentsGuide", () => {
	it("keeps the core short enough to survive `| head -40`, rules and failure recipes first", () => {
		const core = agentsGuide();
		expect(core.split("\n").length).toBeLessThanOrEqual(40);
		expect(core.indexOf("docker run")).toBeLessThan(core.indexOf("Use:"));
		expect(core.indexOf("Could not allocate")).toBeLessThan(
			core.indexOf("help agents <topic>"),
		);
		for (const topic of AGENTS_GUIDE_TOPICS) expect(core).toContain(topic);
	});

	it("prints one topic by its name or an alias, or all of them, and names the topics for an unknown one", () => {
		expect(agentsGuide("runs")).toContain("watchdog");
		const all = agentsGuide("all");
		for (const topic of AGENTS_GUIDE_TOPICS)
			expect(all).toContain(agentsGuide(topic));
		expect(agentsGuide("sql")).toBe(agentsGuide("db"));
		expect(agentsGuide("prisma")).toBe(agentsGuide("db"));
		expect(() => agentsGuide("nope")).toThrow(
			'No agents guide topic named "nope"',
		);
	});
});
