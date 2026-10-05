import { describe, expect, it } from "bun:test";
import { highlightColumns, joinRows, wrapJoint } from "./render";

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

describe("wrapJoint", () => {
	// Rows of a 30-column pane, as an app that wraps itself draws them.
	const cols = 30;

	it("joins a row whose next word did not fit", () => {
		const row = " Shopify CLI could not reach";
		const next = " the dev store.";
		expect(wrapJoint(row, next, cols)).toBe(" ");
		expect(joinRows(row, " ", next)).toBe(
			" Shopify CLI could not reach the dev store.",
		);
	});

	it("joins a cut word without a space", () => {
		const row = " URL: https://example.com/abc";
		const next = " def?x=1";
		expect(wrapJoint(row, next, cols)).toBe("");
		expect(joinRows(row, "", next)).toBe(
			" URL: https://example.com/abcdef?x=1",
		);
	});

	it("joins through a box's border and padding", () => {
		const row = "│ Shopify CLI could not    │";
		const next = "│ reach the dev store.     │";
		expect(wrapJoint(row, next, cols)).toBe(" ");
		expect(joinRows(row, " ", next)).toBe(
			"│ Shopify CLI could not reach the dev store.     │",
		);
	});

	it("keeps a line break the next word would have fit before", () => {
		expect(
			wrapJoint(" Preview ready", " GraphiQL ready", cols),
		).toBeUndefined();
		expect(wrapJoint(" Shopify CLI could not reach", "", cols)).toBeUndefined();
	});

	it("keeps a line break before a long word when the line ends short", () => {
		// A wrapper would have moved a 24-column timestamp down, but a line
		// ending 19 columns from the edge is more likely just a line.
		expect(
			wrapJoint("GET /health", "2026-10-05T12:00:00.000Z up", cols),
		).toBeUndefined();
	});
});
