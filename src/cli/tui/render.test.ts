import { describe, expect, it } from "bun:test";
import {
	highlightColumns,
	highlightMatches,
	joinRows,
	layoutSidebar,
	renderInfo,
	renderOverview,
	wrapJoint,
} from "./render";

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

describe("layoutSidebar", () => {
	it("groups reactive tasks under a non-clickable Tasks divider and maps hit testing", () => {
		const layout = layoutSidebar(
			[
				{ name: "api", state: "ready", unread: false, kind: "app" },
				{ name: "web", state: "ready", unread: false, kind: "app" },
				{
					name: "gen:client",
					state: "stopped",
					detail: "idle",
					unread: false,
					kind: "task",
				},
			],
			3,
			22,
			10,
		);
		const plain = layout.rows.map((r) => Bun.stripANSI(r));
		expect(plain[0]).toContain("Overview");
		expect(plain[2]).toContain("api");
		expect(plain[3]).toContain("web");
		expect(plain[4]).toContain("Tasks");
		expect(plain[5]).toContain("gen:client");
		expect(layout.hitAt(0)).toBe(0);
		expect(layout.hitAt(1)).toBeUndefined();
		expect(layout.hitAt(2)).toBe(1);
		expect(layout.hitAt(3)).toBe(2);
		expect(layout.hitAt(4)).toBeUndefined(); // Tasks divider
		expect(layout.hitAt(5)).toBe(3);
	});

	it("scrolls to keep the selected app in view and preserves hit coordinates", () => {
		const entries = Array.from({ length: 10 }, (_, i) => ({
			name: `app-${i + 1}`,
			state: "ready" as const,
			unread: false,
			kind: "app" as const,
		}));
		// Height 6 => Overview + rule + 4 list rows (last row reserved for `▼` when more sit below).
		const middle = layoutSidebar(entries, 5, 20, 6, 0);
		expect(middle.nextOffset).toBeGreaterThan(0);
		const middlePlain = middle.rows.map((r) => Bun.stripANSI(r));
		expect(middlePlain[1]).toContain("▲");
		expect(middlePlain[5]).toContain("▼");
		expect(middle.hitAt(5)).toBeUndefined();
		const app5Row = middlePlain.findIndex((row) => row.includes("app-5"));
		expect(app5Row).toBeGreaterThanOrEqual(2);
		expect(middle.hitAt(app5Row)).toBe(5);

		// Reaching the last page hides `▼` so the final app uses the bottom row cleanly.
		const bottom = layoutSidebar(entries, 8, 20, 6, middle.nextOffset);
		const bottomPlain = bottom.rows.map((r) => Bun.stripANSI(r));
		expect(bottomPlain[1]).toContain("▲");
		expect(bottomPlain[5]).toContain("app-10");
		expect(bottom.hitAt(5)).toBe(10);
		const app8Row = bottomPlain.findIndex((row) => row.includes("app-8"));
		expect(bottom.hitAt(app8Row)).toBe(8);
	});

	it("truncates long app names and long failure details without clipping the unread badge", () => {
		const layout = layoutSidebar(
			[
				{
					name: "very-long-firebase-functions-app",
					state: "failed",
					detail: "exit 1",
					unread: true,
					kind: "app",
				},
				{
					name: "web",
					state: "failed",
					detail: "web did not respond within 120s",
					unread: true,
					kind: "app",
				},
			],
			0,
			20,
			6,
		);
		const row1 = Bun.stripANSI(layout.rows[2] ?? "");
		expect(Bun.stringWidth(row1)).toBe(20);
		expect(row1).toContain("exit 1!");
		expect(row1).toContain("…");

		const row2 = Bun.stripANSI(layout.rows[3] ?? "");
		expect(Bun.stringWidth(row2)).toBe(20);
		expect(row2).toContain("web");
		expect(row2.endsWith("!")).toBe(true);
	});
});

describe("highlightMatches, renderOverview wrap & renderInfo", () => {
	it("highlights case-insensitive matches without changing row width and keeps concealed text hidden", () => {
		const row = "12:00:00 api       GET /Users/42 200    ";
		const out = highlightMatches(row, "users", 40);
		expect(out).toContain("\u001b[43;30mUsers\u001b[49;39m");
		expect(Bun.stringWidth(out)).toBe(40);

		const concealed = "\u001b[8msecret-token\u001b[28m       ";
		const highlightedConcealed = highlightMatches(concealed, "secret", 20);
		expect(highlightedConcealed).toContain("\u001b[8m");
		expect(Bun.stringWidth(highlightedConcealed)).toBe(20);
	});

	it("soft-wraps long Overview lines onto indented continuation rows", () => {
		const time = new Date("2026-11-27T10:00:00.000Z");
		const rows = renderOverview(
			[
				{
					app: "api",
					raw: "",
					text: "alpha-0123456789 beta-0123456789 gamma-end",
					time,
					event: false,
				},
			],
			{ width: 36, height: 6, scroll: 0, nameWidth: 8, wrap: true },
		);
		const nonBlank = rows.map((r) => Bun.stripANSI(r).trim()).filter(Boolean);
		expect(nonBlank.length).toBeGreaterThan(1);
		expect(nonBlank.join("")).toContain("gamma-end");
	});

	it("renders scrollable info rows at exact width", () => {
		const rows = renderInfo(["line 0", "line 1", "line 2"], 20, 2, 1);
		expect(rows.map((r) => Bun.stripANSI(r).trim())).toEqual([
			"line 1",
			"line 2",
		]);
		expect(Bun.stringWidth(rows[0] ?? "")).toBe(20);
	});
});
