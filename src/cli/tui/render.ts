import type { IBufferCell, IBufferLine } from "@xterm/headless";
import { clamp, typedSwitch } from "hanzio";
import pc from "picocolors";
import type { AppState, OutputLine } from "../../core/process/run-output";
import { colorizeName } from "../../core/style";

// Pure pieces of the TUI's frame: every function returns rows of exactly the
// width asked for, so the frame can be diffed row by row.

/** `text` (ANSI allowed) cut or padded to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";

	const cut =
		Bun.stringWidth(text) > width ? Bun.sliceAnsi(text, 0, width, "…") : text;
	const pad = width - Bun.stringWidth(cut);

	return `${cut}\u001b[0m${" ".repeat(Math.max(0, pad))}`;
}

/**
 * The SGR parameters for one xterm color, or `undefined` for the default color.
 * `base` is 30 for a foreground and 40 for a background.
 */
function color(code: number, rgb: boolean, palette: boolean, base: number) {
	if (rgb) {
		const red = (code >> 16) & 255;
		const green = (code >> 8) & 255;
		const blue = code & 255;
		return `${base + 8};2;${red};${green};${blue}`;
	}

	if (!palette) return undefined;

	// The 16 ANSI colors have their own codes; 90-97 and 100-107 are the bright ones.
	if (code < 8) return `${base + code}`;
	if (code < 16) return `${base + 60 + code - 8}`;

	return `${base + 8};5;${code}`;
}

function cellStyle(cell: IBufferCell): string {
	// Fast path: plain unstyled cells (most of every terminal frame) allocate nothing.
	if (cell.isAttributeDefault() && cell.isFgDefault() && cell.isBgDefault()) {
		return "";
	}

	let out = "";
	const add = (code: string | undefined) => {
		if (code) out = out ? `${out};${code}` : code;
	};

	if (cell.isBold()) add("1");
	if (cell.isDim()) add("2");
	if (cell.isItalic()) add("3");
	if (cell.isUnderline()) add("4");
	if (cell.isInverse()) add("7");
	if (cell.isInvisible()) add("8");
	if (cell.isStrikethrough()) add("9");
	if (!cell.isFgDefault()) {
		add(color(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), 30));
	}
	if (!cell.isBgDefault()) {
		add(color(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), 40));
	}
	return out;
}

/** One row of an app's virtual screen as SGR text, `width` columns wide. */
export function renderScreenRow(
	line: IBufferLine | undefined,
	width: number,
	cell: IBufferCell,
): string {
	if (!line) return " ".repeat(width);

	let out = "";
	let style = "";
	let used = 0;

	for (let x = 0; x < line.length && used < width; x++) {
		const current = line.getCell(x, cell);
		if (!current) break;

		// The second half of a wide character.
		const cellWidth = current.getWidth();
		if (cellWidth === 0) continue;
		if (used + cellWidth > width) break;

		// Reset and re-set the style only where it changes.
		const next = cellStyle(current);
		if (next !== style) {
			out += `\u001b[0${next ? `;${next}` : ""}m`;
			style = next;
		}

		out += current.getChars() || " ";
		used += cellWidth;
	}

	return `${out}\u001b[0m${" ".repeat(width - used)}`;
}

/** An app's row: its state, or `off`, an app the run left out and has not started. */
type SidebarState = AppState | "off";

const GLYPH: Record<SidebarState, string> = {
	starting: pc.yellow("◌"),
	ready: pc.green("●"),
	stopped: pc.dim("○"),
	failed: pc.red("✗"),
	off: pc.dim("·"),
};

export interface SidebarEntry {
	name: string;
	state?: SidebarState;
	/** "exit 1", "stopped", "idle", "running", "ok", "off". */
	detail?: string;
	unread: boolean;
	kind?: "app" | "task";
}

type SidebarItem =
	| { kind: "divider"; label: string }
	| { kind: "entry"; selectIndex: number; entry: SidebarEntry };

export interface SidebarLayout {
	readonly rows: string[];
	readonly nextOffset: number;
	/** Map a 0-based pane row (terminal row - 2) to a selection index, or undefined on dividers/blanks. */
	hitAt(paneRow: number): number | undefined;
}

function buildSidebarItems(entries: readonly SidebarEntry[]): SidebarItem[] {
	const items: SidebarItem[] = [];
	let seenApp = false;
	let insertedTasksDivider = false;

	entries.forEach((entry, index) => {
		const isTask = entry.kind === "task";
		if (!isTask) {
			seenApp = true;
		} else if (seenApp && !insertedTasksDivider) {
			insertedTasksDivider = true;
			items.push({ kind: "divider", label: "Tasks" });
		}
		items.push({ kind: "entry", selectIndex: index + 1, entry });
	});
	return items;
}

function renderSidebarEntry(
	entry: SidebarEntry,
	active: boolean,
	width: number,
): string {
	const state = entry.state ?? "starting";
	const rawLabel = entry.detail ?? state;
	const mark = entry.unread ? pc.red("!") : " ";
	// Reserve 3 cols for ` <glyph> `, 1 separating space, and 1 col for `!`
	// plus at least half the remaining width for the app name so long failure
	// details never crush the name to `…` or clip the `!` unread badge.
	const minNameCols = Math.min(
		Bun.stringWidth(entry.name),
		Math.max(4, Math.floor((width - 5) / 2)),
	);
	const labelBudget = Math.max(0, width - 5 - minNameCols);
	const label =
		labelBudget === 0
			? ""
			: Bun.stringWidth(rawLabel) > labelBudget
				? Bun.sliceAnsi(rawLabel, 0, labelBudget, "…")
				: rawLabel;
	const right = `${pc.dim(label)}${mark}`;
	const rightWidth = Bun.stringWidth(right);
	const nameBudget = Math.max(1, width - 4 - rightWidth);
	const displayName =
		Bun.stringWidth(entry.name) > nameBudget
			? Bun.sliceAnsi(entry.name, 0, nameBudget, "…")
			: entry.name;
	let name = colorizeName(displayName);
	if (active) name = displayName;
	else if (state === "off") name = pc.dim(displayName);
	const left = ` ${GLYPH[state]} ${name}`;
	const gap = Math.max(1, width - Bun.stringWidth(left) - rightWidth);
	const line = `${left}${" ".repeat(gap)}${right}`;
	return active ? `\u001b[7m${fit(line, width)}` : fit(line, width);
}

/**
 * Compute the sidebar's rendered rows, updated scroll offset, and row hit-testing
 * from one layout pass so mouse clicks never drift from scrolled or grouped rows.
 */
export function layoutSidebar(
	entries: readonly SidebarEntry[],
	selected: number,
	width: number,
	height: number,
	scrollOffset = 0,
): SidebarLayout {
	const rows: string[] = [];
	const row = (text: string, active: boolean) =>
		rows.push(active ? `\u001b[7m${fit(text, width)}` : fit(text, width));

	row(` ${selected === 0 ? "▶" : " "} Overview`, selected === 0);

	const items = buildSidebarItems(entries);
	const listHeight = Math.max(0, height - 2);
	const maxOffset = Math.max(0, items.length - listHeight);
	let offset = clamp(scrollOffset, 0, maxOffset);

	// When more items sit below the viewport and there is room for a bottom
	// indicator row, reserve the last row for `▼` so it never overwrites an app's
	// label or `!` unread badge.
	const visibleSlotsFor = (candidateOffset: number): number => {
		if (listHeight <= 0) return 0;
		const fitsToEnd = candidateOffset + listHeight >= items.length;
		if (fitsToEnd || listHeight < 2) return listHeight;
		return listHeight - 1;
	};

	if (selected === 0) {
		offset = 0;
	} else if (listHeight > 0) {
		const selectedItemIndex = items.findIndex(
			(item) => item.kind === "entry" && item.selectIndex === selected,
		);
		if (selectedItemIndex >= 0) {
			if (selectedItemIndex < offset) {
				offset = selectedItemIndex;
				// Keep the "Tasks" divider visible above the first task when it still fits with the task.
				const canShowDividerAbove =
					offset > 0 &&
					items[offset - 1]?.kind === "divider" &&
					selectedItemIndex < offset - 1 + visibleSlotsFor(offset - 1);
				if (canShowDividerAbove) {
					offset -= 1;
				}
			} else if (selectedItemIndex >= offset + visibleSlotsFor(offset)) {
				// If the selected item reaches the final page, anchor at the bottom so `▼` disappears.
				const lastPageOffset = Math.max(0, items.length - listHeight);
				if (selectedItemIndex >= lastPageOffset) {
					offset = lastPageOffset;
				} else {
					const slots = listHeight >= 2 ? listHeight - 1 : listHeight;
					offset = selectedItemIndex - slots + 1;
				}
			}
			offset = clamp(offset, 0, maxOffset);
		}
	}

	const slots = visibleSlotsFor(offset);
	const hasAbove = offset > 0;
	const hasBelow = offset + slots < items.length;
	const topRule = hasAbove
		? `${pc.dim("─".repeat(Math.max(0, width - 2)))}${pc.yellow("▲")} `
		: pc.dim("─".repeat(width));
	rows.push(topRule);

	const visible = items.slice(offset, offset + slots);
	for (const item of visible) {
		if (item.kind === "divider") {
			const prefix = `─ ${item.label} `;
			const fillLen = Math.max(0, width - Bun.stringWidth(prefix));
			rows.push(fit(pc.dim(`${prefix}${"─".repeat(fillLen)}`), width));
		} else {
			rows.push(
				renderSidebarEntry(item.entry, selected === item.selectIndex, width),
			);
		}
	}

	if (hasBelow && listHeight >= 2) {
		rows.push(
			`${pc.dim("─".repeat(Math.max(0, width - 2)))}${pc.yellow("▼")} `,
		);
	}

	while (rows.length < height) rows.push(" ".repeat(width));
	const clipped = rows.slice(0, height);
	const lastIdx = clipped.length - 1;
	const lastRow = lastIdx >= 0 ? clipped[lastIdx] : undefined;
	if (hasBelow && listHeight < 2 && lastRow !== undefined) {
		clipped[lastIdx] = fit(
			`${Bun.sliceAnsi(lastRow, 0, Math.max(0, width - 2))} ${pc.yellow("▼")}`,
			width,
		);
	}

	return {
		rows: clipped,
		nextOffset: offset,
		hitAt: (paneRow) => {
			if (paneRow === 0) return 0;
			if (paneRow < 2) return undefined;
			const item = visible[paneRow - 2];
			return item?.kind === "entry" ? item.selectIndex : undefined;
		},
	};
}

/** An Overview row as plain text, uncut: what a selection of it copies. */
export function overviewPlainLine(line: OutputLine, nameWidth: number): string {
	return `${line.time.toTimeString().slice(0, 8)} ${line.app.padEnd(nameWidth)}  ${line.text}`;
}

// A box's border and padding: what an app's wrapper keeps clear of the edge.
const ROW_START = /^[\s│┃|]*/;
const ROW_END = /[\s│┃|]*$/;
const EDGE_INSET = 3;
// Longer first words are counted as this long: a long word after a line that
// ends short of the edge is more often a new line (a timestamp, a path) than
// a wrap, and a line break kept is safer than two lines merged.
const MAX_WORD = 12;

/**
 * How an app row continues on the next one, if the app wrapped it there
 * itself: Ink and other wrappers break with real newlines, which the terminal
 * cannot tell from the app's own. A greedy wrapper breaks only when the next
 * word does not fit, so a row continues when its text, a space and the next
 * row's first word would not fit the pane (less a border and padding). A word
 * wider than a row, like a URL, was cut and continues without the space. The
 * terminal cannot say which apps wrap themselves, so this is a heuristic: a
 * line that really ends near the edge can still be joined to the next.
 */
export function wrapJoint(
	row: string,
	next: string,
	cols: number,
): "" | " " | undefined {
	const text = row.replace(ROW_END, "");
	const lastWord = /\S*$/.exec(text)?.[0] ?? "";
	const firstWord = /^\S*/.exec(next.replace(ROW_START, ""))?.[0] ?? "";
	if (!lastWord || !firstWord) return undefined;

	const edge = cols - EDGE_INSET;
	const word = Math.min(Bun.stringWidth(firstWord), MAX_WORD);
	const nextWordFits = Bun.stringWidth(text) + 1 + word <= edge;
	if (nextWordFits) return undefined;

	return Bun.stringWidth(lastWord + firstWord) > edge ? "" : " ";
}

/** `row` and `next` as one line, joined by `joint` (see `wrapJoint`). */
export function joinRows(row: string, joint: string, next: string): string {
	return row.replace(ROW_END, "") + joint + next.replace(ROW_START, "");
}

/**
 * A rendered row with columns `[from, to)` in reverse video (the selection).
 * The row keeps its own styles, concealed text included; reverse is laid
 * over them, and set again after every style change inside the selection.
 */
export function highlightColumns(
	row: string,
	from: number,
	to: number,
	width: number,
): string {
	const selected = Bun.sliceAnsi(row, from, to).replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
		/\u001b\[[0-9;]*m/g,
		"$&\u001b[7m",
	);
	const before = Bun.sliceAnsi(row, 0, from);
	const after = Bun.sliceAnsi(row, to);

	return fit(`${before}\u001b[7m${selected}\u001b[27m${after}`, width);
}

/**
 * Highlight all case-insensitive occurrences of `query` in a rendered ANSI row
 * using high-contrast yellow background + black text, keeping row width exact.
 */
export function highlightMatches(
	row: string,
	query: string,
	width: number,
): string {
	if (!query) return row;
	const plain = Bun.stripANSI(row);
	const lowerPlain = plain.toLowerCase();
	const lowerQuery = query.toLowerCase();
	if (!lowerPlain.includes(lowerQuery)) return row;

	const spans: Array<[number, number]> = [];
	let pos = 0;
	while (pos <= lowerPlain.length - lowerQuery.length) {
		const idx = lowerPlain.indexOf(lowerQuery, pos);
		if (idx < 0) break;
		const startCol = Bun.stringWidth(plain.slice(0, idx));
		const endCol =
			startCol + Bun.stringWidth(plain.slice(idx, idx + query.length));
		if (endCol > startCol) spans.push([startCol, endCol]);
		pos = idx + Math.max(1, lowerQuery.length);
	}
	if (spans.length === 0) return row;

	let out = "";
	let cursor = 0;
	for (const [start, end] of spans) {
		if (start > cursor) out += Bun.sliceAnsi(row, cursor, start);
		// Preserve inner SGR attributes (especially SGR 8 concealed text) while
		// overriding foreground/background to yellow-bg/black-fg.
		const matchStyled = Bun.sliceAnsi(row, start, end).replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences
			/\u001b\[[0-9;]*m/g,
			"$&\u001b[43;30m",
		);
		out += `\u001b[43;30m${matchStyled}\u001b[49;39m`;
		cursor = end;
	}
	if (cursor < width) out += Bun.sliceAnsi(row, cursor, width);
	return fit(out, width);
}

/**
 * Split plain text into display-width chunks (`firstCols` for row 0, `contCols`
 * for continuation rows). When `firstCols` is 0 (narrow pane), row 0 is `""`
 * and all text wraps cleanly onto continuation rows without dropping characters.
 */
function wrapTextSegments(
	plainText: string,
	firstCols: number,
	contCols: number,
): string[] {
	if (!plainText) return [""];
	const chunks: string[] = [];
	let rest = plainText;
	if (firstCols <= 0) {
		chunks.push("");
	}
	let budget = firstCols <= 0 ? Math.max(1, contCols) : firstCols;
	while (rest.length > 0) {
		if (Bun.stringWidth(rest) <= budget) {
			chunks.push(rest);
			break;
		}
		const slice = Bun.sliceAnsi(rest, 0, budget);
		// Guard against zero-progress on a wide character wider than `budget`.
		const cut = slice.length > 0 ? slice.length : 1;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
		budget = Math.max(1, contCols);
	}
	return chunks;
}

function styleOverviewText(line: OutputLine, text: string): string {
	return typedSwitch(line.level ?? "output", {
		error: () => pc.red(text),
		warn: () => pc.yellow(text),
		output: () => (line.event ? pc.dim(text) : text),
	});
}

/** Visual-to-logical mapping for one rendered Overview row (supports drag-selection while wrapped). */
export interface OverviewRowMap {
	readonly lineIndex: number;
	/** Start display column within `overviewPlainLine(line, nameWidth)`. */
	readonly plainStart: number;
	/** End display column (exclusive) within `overviewPlainLine(line, nameWidth)`. */
	readonly plainEnd: number;
	/** Visual column where `plainStart` starts (0 on line's first row, `indentCols` on continuations). */
	readonly visualIndent: number;
}

interface OverviewLayout {
	readonly rows: string[];
	readonly rowMap: readonly (OverviewRowMap | undefined)[];
}

interface OverviewRenderOptions {
	width: number;
	height: number;
	scroll: number;
	nameWidth: number;
	wrap?: boolean;
	query?: string;
}

/**
 * Compute Overview rows together with each row's mapping back to `lines` and
 * plain column spans so drag-selection stays exact with line wrapping on or off.
 */
export function layoutOverview(
	lines: readonly OutputLine[],
	options: OverviewRenderOptions,
): OverviewLayout {
	const end = Math.max(0, lines.length - options.scroll);
	const highlight = (row: string) =>
		options.query ? highlightMatches(row, options.query, options.width) : row;

	if (!options.wrap) {
		const first = Math.max(0, end - options.height);
		const visible = lines.slice(first, end);
		const rows = visible.map((line) => {
			const time = pc.dim(line.time.toTimeString().slice(0, 8));
			const namePad = " ".repeat(
				Math.max(0, options.nameWidth - line.app.length),
			);
			const name = `${colorizeName(line.app)}${namePad}`;
			const text = styleOverviewText(line, line.text);
			return highlight(fit(`${time} ${name}  ${text}`, options.width));
		});
		const rowMap: Array<OverviewRowMap | undefined> = visible.map((_, i) => ({
			lineIndex: first + i,
			plainStart: 0,
			plainEnd: Number.MAX_SAFE_INTEGER,
			visualIndent: 0,
		}));
		while (rows.length < options.height) {
			rows.unshift(" ".repeat(options.width));
			rowMap.unshift(undefined);
		}
		return { rows, rowMap };
	}

	// Walk backwards from `end - 1` wrapping only enough logical lines to fill `height` rows.
	const prefixWidth = 8 + 1 + options.nameWidth + 2;
	const indentCols = options.width > prefixWidth + 12 ? prefixWidth : 2;
	const firstBodyCols = Math.max(0, options.width - prefixWidth);
	const contBodyCols = Math.max(1, options.width - indentCols);
	const indent = " ".repeat(indentCols);

	const collectedRows: string[] = [];
	const collectedMap: OverviewRowMap[] = [];
	for (let i = end - 1; i >= 0 && collectedRows.length < options.height; i--) {
		const line = lines[i];
		if (!line) continue;
		const time = pc.dim(line.time.toTimeString().slice(0, 8));
		const namePad = " ".repeat(
			Math.max(0, options.nameWidth - line.app.length),
		);
		const name = `${colorizeName(line.app)}${namePad}`;
		const prefix = `${time} ${name}  `;

		const plainBody = Bun.stripANSI(line.text);
		const segments = wrapTextSegments(plainBody, firstBodyCols, contBodyCols);
		const lineEntries: Array<{ row: string; map: OverviewRowMap }> = [];
		let plainCol = prefixWidth;
		for (const [s, part] of segments.entries()) {
			const segWidth = Bun.stringWidth(part);
			if (s === 0) {
				lineEntries.push({
					row: highlight(
						fit(`${prefix}${styleOverviewText(line, part)}`, options.width),
					),
					map: {
						lineIndex: i,
						plainStart: 0,
						plainEnd: prefixWidth + segWidth,
						visualIndent: 0,
					},
				});
			} else {
				lineEntries.push({
					row: highlight(
						fit(`${indent}${styleOverviewText(line, part)}`, options.width),
					),
					map: {
						lineIndex: i,
						plainStart: plainCol,
						plainEnd: plainCol + segWidth,
						visualIndent: indentCols,
					},
				});
			}
			plainCol += segWidth;
		}
		for (let r = lineEntries.length - 1; r >= 0; r--) {
			const entry = lineEntries[r];
			if (!entry) continue;
			collectedRows.push(entry.row);
			collectedMap.push(entry.map);
		}
	}

	collectedRows.reverse();
	collectedMap.reverse();
	const rows = collectedRows.slice(-options.height);
	const rowMap: Array<OverviewRowMap | undefined> = collectedMap.slice(
		-options.height,
	);
	while (rows.length < options.height) {
		rows.unshift(" ".repeat(options.width));
		rowMap.unshift(undefined);
	}
	return { rows, rowMap };
}

/** Overview rows: every app's lines, interleaved by time, newest at the bottom. */
export function renderOverview(
	lines: readonly OutputLine[],
	options: OverviewRenderOptions,
): string[] {
	return layoutOverview(lines, options).rows;
}

/** Render a scrollable info/help pane of pre-styled lines. */
export function renderInfo(
	lines: readonly string[],
	width: number,
	height: number,
	scroll: number,
): string[] {
	const maxScroll = Math.max(0, lines.length - height);
	const start = clamp(scroll, 0, maxScroll);
	const visible = lines.slice(start, start + height);
	const rows = visible.map((line) => fit(line, width));
	while (rows.length < height) rows.push(" ".repeat(width));
	return rows;
}

/** Key hints, built-in first, then apps' declared actions by app. */
export function renderFooter(
	hints: readonly string[],
	actions: readonly { app: string; key: string; label: string }[],
	width: number,
): string {
	const byApp = new Map<string, string[]>();
	for (const action of actions) {
		const list = byApp.get(action.app) ?? [];
		list.push(`${pc.bold(action.key)} ${action.label}`);
		byApp.set(action.app, list);
	}

	const declared = [...byApp].map(
		([app, list]) => `${colorizeName(app)}: ${list.join(pc.dim(" · "))}`,
	);
	const text = [hints.join(pc.dim(" · ")), ...declared].join(pc.dim(" │ "));
	return fit(` ${text}`, width);
}
