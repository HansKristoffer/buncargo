import { Terminal } from "@xterm/headless";
import type { PtyApp } from "./pty-app";

/** Scrollback each app's virtual screen keeps. */
export const SCREEN_SCROLLBACK = 10_000;

/** Commits in a row without an upward move before an app counts as line-oriented again. */
const CALM_COMMITS = 3;

/**
 * One app's virtual terminal: xterm.js without a browser, fed by the app's
 * pseudo-terminal. The TUI draws its buffer; this class also turns the screen
 * back into plain lines for the Overview and the log file.
 *
 * A full-screen app's output is a screen, not lines, so only *committed* rows
 * become lines. An app that redraws (Ink's live footer, a spinner) moves its
 * cursor up over the rows it redraws; rows that far above the cursor are held
 * back, and a row the app went back and rewrote is sent again only if its
 * text changed. A log line printed above a footer therefore lands once the
 * footer is drawn below it, and the footer itself only when the app exits.
 * The alternate screen is never fed; its last state is, at exit.
 *
 * Known ceiling: the very first frame of a live footer looks like plain lines
 * (nothing has been redrawn yet), so its top rows can appear once.
 */
export class AppScreen {
	readonly term: Terminal;
	cursorVisible = true;
	private pty?: PtyApp;
	/** Absolute normal-buffer row of the next line to emit. */
	private emitted = 0;
	/** Top row an upward move reached since the last commit. */
	private low = Number.POSITIVE_INFINITY;
	/** How far above the cursor the last redraw reached. */
	private reach = 0;
	/** Rows above the cursor held back as live. */
	private live = 0;
	private calm = 0;
	/** What each recent row was sent as, so a redraw of the same text is not repeated. */
	private sent = new Map<number, string>();
	private anchor?: {
		marker: { line: number; isDisposed: boolean; dispose(): void };
		line: number;
	};

	constructor(
		cols: number,
		rows: number,
		private readonly onLine: (text: string) => void,
	) {
		this.term = new Terminal({
			cols,
			rows,
			scrollback: SCREEN_SCROLLBACK,
			allowProposedApi: true,
		});
		// Answers to the app's own queries (cursor position, device attributes).
		this.term.onData((data) => this.pty?.write(data));

		// Every way a cursor moves up: the rows from there down are being redrawn.
		const up = (target: (cursor: number) => number) => () => {
			const buffer = this.term.buffer.active;
			if (buffer.type !== "normal") return false;
			const to = Math.max(0, target(buffer.cursorY));
			if (to < buffer.cursorY) {
				this.low = Math.min(this.low, buffer.baseY + to);
				this.reach = Math.max(this.reach, buffer.cursorY - to);
			}
			return false;
		};
		const param = (params: (number | number[])[]) => {
			const value = params[0];
			return typeof value === "number" && value > 0 ? value : 1;
		};
		const parser = this.term.parser;
		for (const final of ["A", "F"])
			parser.registerCsiHandler({ final }, (params) =>
				up((y) => y - param(params))(),
			);
		for (const final of ["H", "f", "d"])
			parser.registerCsiHandler({ final }, (params) =>
				up(() => param(params) - 1)(),
			);
		parser.registerEscHandler(
			{ final: "M" },
			up((y) => y - 1),
		);
		for (const [final, visible] of [
			["h", true],
			["l", false],
		] as const)
			parser.registerCsiHandler({ prefix: "?", final }, (params) => {
				if (params.includes(25)) this.cursorVisible = visible;
				return false;
			});
	}

	/** Route input, resizes and terminal answers to this process. */
	bind(pty: PtyApp): void {
		this.pty = pty;
	}

	write(data: Uint8Array | string): void {
		this.term.write(data, () => this.commit(false));
	}

	input(data: string): void {
		// Arrow keys as the app asked for them (DECCKM), not as our terminal sends them.
		const keys = this.term.modes.applicationCursorKeysMode
			? // biome-ignore lint/suspicious/noControlCharactersInRegex: arrow keys are escapes
				data.replace(/\u001b\[([ABCD])/g, "\u001bO$1")
			: data;
		this.pty?.write(keys);
	}

	resize(cols: number, rows: number): void {
		if (cols === this.term.cols && rows === this.term.rows) return;
		this.term.resize(cols, rows);
		this.pty?.resize(cols, rows);
	}

	/** Emit what is left on screen; the app is gone and will not redraw it. */
	flush(): Promise<void> {
		return new Promise((resolve) =>
			this.term.write("", () => {
				this.commit(true);
				resolve();
			}),
		);
	}

	private commit(final: boolean): void {
		const normal = this.term.buffer.normal;
		// Rows shift up once the scrollback is full; a marker follows them.
		if (this.anchor) {
			const shift = this.anchor.line - this.anchor.marker.line;
			if (shift > 0 && !this.anchor.marker.isDisposed) {
				this.emitted = Math.max(0, this.emitted - shift);
				this.low -= shift;
				this.sent = new Map(
					[...this.sent].map(([row, text]) => [row - shift, text]),
				);
			}
			this.anchor.marker.dispose();
		}

		if (this.reach > 0) {
			this.live = this.reach;
			this.calm = 0;
		} else if (++this.calm >= CALM_COMMITS) this.live = 0;

		const cursor = normal.baseY + normal.cursorY;
		const start = Math.min(this.emitted, this.low);
		const end = final
			? lastContentRow(normal) + 1
			: Math.min(cursor - this.live, normal.length);
		if (this.term.buffer.active.type === "normal" || final)
			this.emitRows(normal, start, end);
		this.emitted = Math.max(start, end);

		if (final && this.term.buffer.active.type === "alternate") {
			const alt = this.term.buffer.alternate;
			for (let row = 0; row <= lastContentRow(alt); row++)
				this.onLine(alt.getLine(row)?.translateToString(true) ?? "");
		}

		for (const row of this.sent.keys())
			if (row < this.emitted - 500) this.sent.delete(row);
		this.low = Number.POSITIVE_INFINITY;
		this.reach = 0;
		const marker = this.term.registerMarker(0);
		this.anchor = marker ? { marker, line: marker.line } : undefined;
	}

	/** Rows `[start, end)`, wrapped rows joined, unchanged ones skipped. */
	private emitRows(
		buffer: Terminal["buffer"]["normal"],
		start: number,
		end: number,
	): void {
		let pending: { row: number; text: string } | undefined;
		const send = () => {
			if (!pending || this.sent.get(pending.row) === pending.text) return;
			this.sent.set(pending.row, pending.text);
			this.onLine(pending.text);
		};
		for (let row = start; row < end; row++) {
			const line = buffer.getLine(row);
			if (!line) continue;
			const text = line.translateToString(true);
			if (line.isWrapped && pending) pending.text += text;
			else {
				send();
				pending = { row, text };
			}
		}
		send();
	}

	dispose(): void {
		this.anchor?.marker.dispose();
		this.term.dispose();
	}
}

function lastContentRow(buffer: {
	length: number;
	getLine(y: number): { translateToString(trim?: boolean): string } | undefined;
}): number {
	for (let row = buffer.length - 1; row >= 0; row--)
		if (buffer.getLine(row)?.translateToString(true).trim()) return row;
	return -1;
}
