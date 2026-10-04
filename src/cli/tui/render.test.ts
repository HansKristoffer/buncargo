import { describe, expect, it } from "bun:test";
import { highlightColumns } from "./render";

describe("highlightColumns", () => {
	// An app row as `renderScreenRow` draws it, with concealed text (SGR 8).
	const row = "visible \u001b[0;8mSECRET\u001b[0m suffix";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
	const concealed = /\u001b\[(?:[0-9;]*;)?8m[^\u001b]*SE/;

	it("keeps concealed text concealed outside the selection", () => {
		const out = highlightColumns(row, 0, 4, 30);
		expect(out).toStartWith("\u001b[7mvisi");
		expect(out).toMatch(concealed);
	});

	it("keeps concealed text concealed inside the selection", () => {
		const out = highlightColumns(row, 6, 12, 30);
		// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
		expect(out).toMatch(/\u001b\[(?:[0-9;]*;)?8m(\u001b\[7m)?SEC/);
		expect(Bun.stringWidth(out)).toBe(30);
	});
});
