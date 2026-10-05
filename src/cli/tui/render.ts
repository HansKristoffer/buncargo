import type { IBufferCell, IBufferLine } from "@xterm/headless";
import pc from "picocolors";
import type { AppState, OutputLine } from "../../core/process/run-output";
import { colorizeName } from "../../core/style";

/**
 * Pure pieces of the TUI's frame: every function returns rows of exactly the
 * width asked for, so the frame can be diffed row by row.
 */

/** `text` (ANSI allowed) cut or padded to exactly `width` columns. */
export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const cut =
		Bun.stringWidth(text) > width ? Bun.sliceAnsi(text, 0, width, "…") : text;
	const pad = width - Bun.stringWidth(cut);
	return `${cut}\u001b[0m${" ".repeat(Math.max(0, pad))}`;
}

function color(code: number, rgb: boolean, palette: boolean, base: number) {
	if (rgb)
		return `${base + 8};2;${(code >> 16) & 255};${(code >> 8) & 255};${code & 255}`;
	if (!palette) return undefined;
	if (code < 8) return `${base + code}`;
	if (code < 16) return `${base + 60 + code - 8}`;
	return `${base + 8};5;${code}`;
}

function cellStyle(cell: IBufferCell): string {
	const codes: (string | undefined)[] = [
		cell.isBold() ? "1" : undefined,
		cell.isDim() ? "2" : undefined,
		cell.isItalic() ? "3" : undefined,
		cell.isUnderline() ? "4" : undefined,
		cell.isInverse() ? "7" : undefined,
		cell.isInvisible() ? "8" : undefined,
		cell.isStrikethrough() ? "9" : undefined,
		color(cell.getFgColor(), cell.isFgRGB(), cell.isFgPalette(), 30),
		color(cell.getBgColor(), cell.isBgRGB(), cell.isBgPalette(), 40),
	];
	return codes.filter(Boolean).join(";");
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
		const cellWidth = current.getWidth();
		if (cellWidth === 0) continue;
		if (used + cellWidth > width) break;
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

const GLYPH: Record<AppState, string> = {
	starting: pc.yellow("◌"),
	ready: pc.green("●"),
	stopped: pc.dim("○"),
	failed: pc.red("✗"),
};

export interface SidebarEntry {
	name: string;
	state?: AppState;
	/** "exit 1", shown for a stopped or failed app. */
	detail?: string;
	unread: boolean;
}

/** The sidebar: Overview, a rule, then each app with its state. */
export function renderSidebar(
	entries: readonly SidebarEntry[],
	selected: number,
	width: number,
	height: number,
): string[] {
	const rows: string[] = [];
	const row = (text: string, active: boolean) =>
		rows.push(active ? `\u001b[7m${fit(text, width)}` : fit(text, width));
	row(` ${selected === 0 ? "▶" : " "} Overview`, selected === 0);
	rows.push(pc.dim("─".repeat(width)));
	entries.forEach((entry, index) => {
		const active = selected === index + 1;
		const state = entry.state ?? "starting";
		const label =
			(state === "stopped" || state === "failed") && entry.detail
				? entry.detail
				: state;
		const mark = entry.unread ? pc.red("!") : " ";
		const name = active ? entry.name : colorizeName(entry.name);
		const left = ` ${GLYPH[state]} ${name}`;
		const right = `${pc.dim(label)}${mark}`;
		const gap = width - Bun.stringWidth(left) - Bun.stringWidth(right);
		row(
			gap > 0 ? `${left}${" ".repeat(gap)}${right}` : `${left} ${right}`,
			active,
		);
	});
	while (rows.length < height) rows.push(" ".repeat(width));
	return rows.slice(0, height);
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
	if (Bun.stringWidth(text) + 1 + word <= edge) return undefined;
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
	return fit(
		`${Bun.sliceAnsi(row, 0, from)}\u001b[7m${selected}\u001b[27m${Bun.sliceAnsi(row, to)}`,
		width,
	);
}

/** Overview rows: every app's lines, interleaved by time, newest at the bottom. */
export function renderOverview(
	lines: readonly OutputLine[],
	options: { width: number; height: number; scroll: number; nameWidth: number },
): string[] {
	const end = Math.max(0, lines.length - options.scroll);
	const visible = lines.slice(Math.max(0, end - options.height), end);
	const rows = visible.map((line) => {
		const time = pc.dim(line.time.toTimeString().slice(0, 8));
		const name = `${colorizeName(line.app)}${" ".repeat(Math.max(0, options.nameWidth - line.app.length))}`;
		const text =
			line.level === "error"
				? pc.red(line.text)
				: line.level === "warn"
					? pc.yellow(line.text)
					: line.event
						? pc.dim(line.text)
						: line.text;
		return fit(`${time} ${name}  ${text}`, options.width);
	});
	while (rows.length < options.height) rows.unshift(" ".repeat(options.width));
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
