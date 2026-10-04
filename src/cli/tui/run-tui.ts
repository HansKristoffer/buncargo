import { writeSync } from "node:fs";
import { format } from "node:util";
import type { IMarker } from "@xterm/headless";
import pc from "picocolors";
import { openUrl } from "../../core/open-url";
import type { OutputLine, RunOutput } from "../../core/process/run-output";
import { colorizeName } from "../../core/style";
import { copyToClipboard } from "./clipboard";
import {
	fit,
	highlightColumns,
	overviewPlainLine,
	renderFooter,
	renderOverview,
	renderScreenRow,
	renderSidebar,
} from "./render";

/**
 * The run's terminal UI: a sidebar with the Overview and every app, and a
 * main pane with either all apps' lines interleaved or one app's own
 * terminal. Each app runs under its own pseudo-terminal sized to the pane
 * (`RunOutput.terminalSize`), so a full-screen app draws itself correctly
 * here while the others keep running one keypress away.
 *
 * It owns the terminal while it runs: raw mode, the alternate screen, a hidden
 * cursor, and stdout/console — anything else printing would scribble over the
 * frame, so it lands in the Overview as a `buncargo` line instead. `stop()`
 * gives all of that back, and so does process exit, whatever caused it.
 */

/** A key an app or integration declared (`AppConfig.actions`). */
export interface TuiAction {
	app: string;
	key: string;
	label: string;
	/** Capture name whose value is the URL to open. */
	open: string;
}

export interface RunTuiOptions {
	output: RunOutput;
	apps: readonly string[];
	/** The URL `o` opens for an app (what BuncargoBar's open does). */
	urlFor(app: string): string | undefined;
	actions?: readonly TuiAction[];
	/** The log file of an app, or the run's log directory for the Overview. */
	logPath?(app: string | undefined): string | undefined;
	/** Quit the run (`q`). */
	quit(): void;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	/** Where a selection goes. Default: the system clipboard. */
	copy?(text: string): "clipboard" | "terminal";
}

const SIDEBAR_MIN = 18;
const SIDEBAR_MAX = 32;
const FRAME_MS = 33;
const OVERVIEW_LINES = 10_000;
/**
 * Leaving interact mode: Esc on its own, or Ctrl-] (what Turborepo and telnet
 * use, but out of reach on layouts where `]` needs Option). Arrow keys, Alt
 * combinations and mouse reports start with the same byte as Esc, so input is
 * read as keys rather than chunks: a sequence cut off at the end of a chunk
 * waits for the rest, and an Esc nothing follows within `ESC_WAIT_MS` is the
 * Esc key. The price: an app cannot be sent a bare Esc.
 */
const ESC = "\u001b";
const LEAVE = "\u001d";
const ESC_WAIT_MS = 30;

/**
 * Mouse reporting (SGR encoding, with drags): the wheel scrolls the pane, a
 * click selects in the sidebar, and a drag in the pane selects text, which
 * the TUI copies itself, the way tmux does: the terminal cannot select while
 * it reports the mouse (Option- or Shift-drag still selects natively).
 */
const MOUSE_ON = "\u001b[?1000h\u001b[?1002h\u001b[?1006h";
const MOUSE_OFF = "\u001b[?1000l\u001b[?1002l\u001b[?1006l";
const ENTER_SCREEN = `\u001b[?1049h\u001b[?25l\u001b[H\u001b[2J${MOUSE_ON}`;
const LEAVE_SCREEN = `${MOUSE_OFF}\u001b[0m\u001b[?25h\u001b[?1049l`;
/** Lines one wheel notch scrolls. */
const WHEEL_LINES = 3;

/** One key: a CSI sequence (arrows, function keys, mouse reports), an SS3 key, an Alt combination, or one character. */
const KEY =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: keys are escape sequences
	/\u001b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]|\u001bO[\s\S]|\u001b[^[O\u001b]|[\s\S]/g;
/** The start of a key cut off at the end of the input so far. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: keys are escape sequences
const PARTIAL = /\u001b(?:\[[\x30-\x3f]*[\x20-\x2f]*|O)?$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: mouse reports are escape sequences
const MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * One end of a selection, held by what it points at rather than where that
 * is now: an Overview line, or a marker on the app's buffer row (the alternate
 * screen has no scrollback and takes no markers, so there it is the row).
 */
interface SelectionEnd {
	col: number;
	line?: OutputLine;
	marker?: IMarker;
	row?: number;
}

export class RunTui {
	private selected = 0;
	private interacting = false;
	private errorsOnly = false;
	private picker: number | undefined;
	/** Text selected in a pane, in display columns. */
	private selection?: {
		pane: string;
		/** The app buffer it was made in: a switch to the other one ends it. */
		buffer?: string;
		anchor: SelectionEnd;
		head: SelectionEnd;
		/** The mouse position the head was taken at. */
		at: string;
		dragging: boolean;
	};
	/** Input that may be the start of a key still arriving. */
	private pending = "";
	private escTimer?: ReturnType<typeof setTimeout>;
	private message: string | undefined;
	private scroll = new Map<string, number>();
	private unread = new Set<string>();
	private lines: OutputLine[] = [];
	private frame: string[] = [];
	private dirty = true;
	private timer?: ReturnType<typeof setTimeout>;
	private lastRender = 0;
	private active = false;
	private suspended = false;
	private pager?: Bun.Subprocess;
	private hooked = new WeakSet<object>();
	private unsubscribe?: () => void;
	private restoreOutput?: () => void;
	private readonly stdin: NodeJS.ReadStream;
	private readonly stdout: NodeJS.WriteStream;
	private readonly onInput = (data: Buffer | string) =>
		this.input(String(data));
	private readonly onResize = () => this.layout(true);
	private readonly onExit = () => this.restoreTerminal();

	constructor(private readonly options: RunTuiOptions) {
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
	}

	/** Pane size every app's terminal gets. */
	paneSize(): { cols: number; rows: number } {
		const { cols, rows } = this.size();
		return {
			cols: Math.max(20, cols - this.sidebarWidth() - 1),
			rows: Math.max(4, rows - 2),
		};
	}

	start(): void {
		const { output } = this.options;
		output.terminalSize = () => this.paneSize();
		this.unsubscribe = output.subscribe({
			line: (line) => {
				this.lines.push(line);
				if (this.lines.length > OVERVIEW_LINES) this.lines.shift();
				if (line.level === "error" && this.selectedApp() !== line.app)
					this.unread.add(line.app);
				// Keep a scrolled-back view where it is.
				const overview = this.scroll.get("") ?? 0;
				if (overview > 0 && (!this.errorsOnly || line.level !== undefined))
					this.scroll.set("", overview + 1);
				this.invalidate();
			},
			state: () => this.invalidate(),
			capture: () => this.invalidate(),
		});
		this.captureOutput();
		this.active = true;
		this.write(ENTER_SCREEN);
		this.stdin.setRawMode?.(true);
		this.stdin.resume();
		this.stdin.on("data", this.onInput);
		this.stdout.on("resize", this.onResize);
		process.on("exit", this.onExit);
		this.invalidate();
	}

	stop(): void {
		if (!this.active) return;
		this.active = false;
		// An open pager would hold the terminal past the run.
		this.pager?.kill();
		clearTimeout(this.timer);
		clearTimeout(this.escTimer);
		this.unsubscribe?.();
		this.stdin.off("data", this.onInput);
		this.stdout.off("resize", this.onResize);
		process.off("exit", this.onExit);
		this.restoreTerminal();
		this.restoreOutput?.();
		this.stdin.pause();
	}

	/** Sync, so it also works from a process `exit` handler. */
	private restoreTerminal(): void {
		try {
			this.stdin.setRawMode?.(false);
		} catch {
			// Not a terminal any more.
		}
		try {
			const fd = (this.stdout as { fd?: number }).fd;
			if (fd === undefined) this.stdout.write(LEAVE_SCREEN);
			else writeSync(fd, LEAVE_SCREEN);
		} catch {
			// Nothing to restore on.
		}
	}

	/**
	 * Route console and stdout/stderr writes into the Overview while the TUI
	 * owns the screen. The TUI itself writes through the saved originals.
	 */
	private captureOutput(): void {
		const { output } = this.options;
		const log = (text: string) => {
			for (const line of text.split("\n")) output.line("buncargo", line);
		};
		const saved = {
			stdout: process.stdout.write,
			stderr: process.stderr.write,
			log: console.log,
			info: console.info,
			warn: console.warn,
			error: console.error,
			debug: console.debug,
		};
		const realWrite =
			this.stdout === process.stdout
				? saved.stdout.bind(process.stdout)
				: this.stdout.write.bind(this.stdout);
		this.write = (text) => realWrite(text);
		// Both Writable overloads: a caller awaiting the callback must not hang.
		const capture = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			log(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			const done =
				typeof encodingOrCallback === "function"
					? encodingOrCallback
					: callback;
			if (done) queueMicrotask(() => done(null));
			return true;
		}) as typeof process.stdout.write;
		process.stdout.write = capture;
		process.stderr.write = capture;
		for (const method of ["log", "info", "warn", "error", "debug"] as const)
			console[method] = (...args: unknown[]) => log(format(...args));
		this.restoreOutput = () => {
			process.stdout.write = saved.stdout;
			process.stderr.write = saved.stderr;
			for (const method of ["log", "info", "warn", "error", "debug"] as const)
				console[method] = saved[method];
		};
	}

	private write: (text: string) => void = (text) => this.stdout.write(text);

	private size(): { cols: number; rows: number } {
		return { cols: this.stdout.columns || 100, rows: this.stdout.rows || 30 };
	}

	private sidebarWidth(): number {
		const longest = Math.max(
			0,
			...this.options.apps.map((name) => name.length),
		);
		return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, longest + 14));
	}

	private selectedApp(): string | undefined {
		return this.selected === 0
			? undefined
			: this.options.apps[this.selected - 1];
	}

	private invalidate(): void {
		this.dirty = true;
		if (!this.active || this.suspended || this.timer) return;
		const wait = Math.max(0, FRAME_MS - (performance.now() - this.lastRender));
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.render();
		}, wait);
	}

	private layout(full: boolean): void {
		const pane = this.paneSize();
		for (const screen of this.options.output.screens.values())
			screen.resize(pane.cols, pane.rows);
		if (full) this.frame = [];
		this.invalidate();
	}

	// ── Input ────────────────────────────────────────────────────────────────

	private input(data: string): void {
		if (this.suspended) return;
		clearTimeout(this.escTimer);
		data = this.pending + data;
		const partial = PARTIAL.exec(data);
		this.pending = partial?.[0] ?? "";
		this.keys(data.slice(0, partial?.index).match(KEY) ?? []);
		// Only time tells a lone Esc from the start of a longer key.
		if (this.pending)
			this.escTimer = setTimeout(() => {
				const key = this.pending;
				this.pending = "";
				if (this.active && !this.suspended) this.keys([key]);
			}, ESC_WAIT_MS);
	}

	private keys(keys: readonly string[]): void {
		let typed = "";
		const send = () => {
			const app = this.selectedApp();
			if (typed && app) this.options.output.screens.get(app)?.input(typed);
			typed = "";
		};
		for (const key of keys) {
			const mouse = MOUSE.exec(key);
			// Mouse reports are ours (the wheel scrolls the pane): an app that
			// never asked for them must not receive them as typed input.
			if (mouse) {
				if (this.picker === undefined) this.mouse(mouse);
			} else if (!this.interacting) this.key(key);
			else if (key === ESC || key === LEAVE) {
				send();
				this.interacting = false;
			} else typed += key;
		}
		send();
		this.invalidate();
	}

	private key(key: string): void {
		this.message = undefined;
		this.clearSelection();
		const app = this.selectedApp();
		const count = this.options.apps.length + 1;

		if (this.picker !== undefined) {
			const targets = this.urlTargets();
			if (key === "\u001b[A" || key === "k")
				this.picker = Math.max(0, this.picker - 1);
			else if (key === "\u001b[B" || key === "j")
				this.picker = Math.min(targets.length - 1, this.picker + 1);
			else if (key === "\r") {
				const target = targets[this.picker];
				if (target) this.open(target[1]);
				this.picker = undefined;
			} else this.picker = undefined;
			return;
		}

		switch (key) {
			case "\u001b[A":
			case "k":
				this.select((this.selected - 1 + count) % count);
				return;
			case "\u001b[B":
			case "j":
				this.select((this.selected + 1) % count);
				return;
			case "\u001b":
				this.select(0);
				return;
			case "\r":
				if (app && this.options.output.screens.has(app))
					this.interacting = true;
				return;
			case "\u001b[5~":
				this.scrollBy(this.paneSize().rows - 1);
				return;
			case "\u001b[6~":
				this.scrollBy(-(this.paneSize().rows - 1));
				return;
			// End: back to the live bottom. Home: the oldest line kept.
			case "\u001b[F":
			case "\u001bOF":
			case "\u001b[4~":
				this.scroll.set(app ?? "", 0);
				return;
			case "\u001b[H":
			case "\u001bOH":
			case "\u001b[1~":
				this.scrollBy(Number.MAX_SAFE_INTEGER);
				return;
			case "e":
				if (!app) {
					this.errorsOnly = !this.errorsOnly;
					this.scroll.set("", 0);
				}
				return;
			case "o":
				if (app) {
					const url = this.options.urlFor(app);
					if (url) this.open(url);
					else this.message = `${app} has no URL`;
				} else if (this.urlTargets().length > 0) this.picker = 0;
				else this.message = "No app has a URL yet";
				return;
			case "r":
				if (app) {
					const restart = this.options.output.controls?.restart;
					if (restart) void restart(app).catch(() => {});
					this.message = `Restarting ${app}…`;
				}
				return;
			case "l":
				void this.openLog(app);
				return;
			case "\u000c":
				this.frame = [];
				return;
			case "q":
			case "\u0003":
				this.options.quit();
				return;
		}
		const action = this.liveActions().find((entry) => entry.key === key);
		if (action) this.open(action.url);
	}

	/**
	 * A mouse report: the wheel scrolls, a click in the sidebar selects, and a
	 * drag in the pane selects text, copied when the button is released.
	 */
	private mouse(match: RegExpMatchArray): void {
		const button = Number(match[1]) & ~0b11100; // drop Shift/Alt/Ctrl
		const column = Number(match[2]);
		const row = Number(match[3]);
		const pressed = match[4] === "M";
		if (button === 64) this.scrollBy(WHEEL_LINES);
		else if (button === 65) this.scrollBy(-WHEEL_LINES);
		else if (button === 0 && pressed) {
			this.clearSelection();
			if (column <= this.sidebarWidth()) {
				if (this.interacting) return;
				// Row 1 is the header; then Overview, the rule, and the apps.
				const entry = row - 2;
				if (entry === 0) this.select(0);
				else if (entry >= 2 && entry - 1 <= this.options.apps.length)
					this.select(entry - 1);
				return;
			}
			const end = this.endAt(column, row);
			const app = this.selectedApp();
			if (end)
				this.selection = {
					pane: app ?? "",
					buffer: app
						? this.options.output.screens.get(app)?.term.buffer.active.type
						: undefined,
					anchor: end,
					head: end,
					at: `${column};${row}`,
					dragging: true,
				};
		} else if (this.selection?.dragging && (button === 32 || !pressed)) {
			// A drag, or the release that ends it, moves the head. A pointer
			// that has not moved keeps the text it was on, even if output
			// scrolled other text under it since.
			const end =
				this.selection.at === `${column};${row}`
					? undefined
					: this.endAt(column, row);
			if (end) {
				this.selection.at = `${column};${row}`;
				if (this.selection.head !== this.selection.anchor)
					this.selection.head.marker?.dispose();
				this.selection.head = end;
			}
			if (pressed) return;
			this.selection.dragging = false;
			const range = this.orderedSelection();
			if (
				!range ||
				(range.start.row === range.end.row && range.start.col === range.end.col)
			)
				this.clearSelection();
			else this.copySelection(range);
		}
	}

	/** A selection end at a mouse position in the pane. */
	private endAt(column: number, row: number): SelectionEnd | undefined {
		const point = this.pointAt(column, row);
		if (!point) return undefined;
		const app = this.selectedApp();
		if (!app) {
			const line = this.overviewLines()[point.row];
			return line && { col: point.col, line };
		}
		const term = this.options.output.screens.get(app)?.term;
		if (!term) return undefined;
		const buffer = term.buffer.active;
		if (buffer.type === "alternate") return { col: point.col, row: point.row };
		const marker = term.registerMarker(
			point.row - (buffer.baseY + buffer.cursorY),
		);
		return marker && { col: point.col, marker };
	}

	/** The content row a selection end points at now, if it still exists. */
	private resolve(end: SelectionEnd): number | undefined {
		if (end.line) {
			const index = this.overviewLines().indexOf(end.line);
			return index < 0 ? undefined : index;
		}
		if (end.marker) return end.marker.isDisposed ? undefined : end.marker.line;
		return end.row;
	}

	private clearSelection(): void {
		this.selection?.anchor.marker?.dispose();
		this.selection?.head.marker?.dispose();
		this.selection = undefined;
	}

	/** Where a mouse position falls in the shown pane's content, clamped to it. */
	private pointAt(
		column: number,
		row: number,
	): { row: number; col: number } | undefined {
		const pane = this.paneSize();
		const x = Math.min(
			pane.cols - 1,
			Math.max(0, column - this.sidebarWidth() - 2),
		);
		const y = Math.min(pane.rows - 1, Math.max(0, row - 2));
		const content = this.contentRow(y, true);
		return content === undefined ? undefined : { row: content, col: x };
	}

	/**
	 * The content row on screen row `y` of the pane: an index into the
	 * Overview's lines, or an absolute row of the app's buffer. `clamp` maps
	 * the Overview's blank top rows onto its first line instead of nothing.
	 */
	private contentRow(y: number, clamp = false): number | undefined {
		const app = this.selectedApp();
		const pane = this.paneSize();
		if (!app) {
			const count = this.overviewLines().length;
			if (count === 0) return undefined;
			const end = Math.max(0, count - (this.scroll.get("") ?? 0));
			const first = Math.max(0, end - pane.rows);
			const index = first + y - (pane.rows - (end - first));
			if (index >= first) return Math.min(index, count - 1);
			return clamp ? first : undefined;
		}
		const screen = this.options.output.screens.get(app);
		if (!screen) return undefined;
		const buffer = screen.term.buffer.active;
		return Math.max(0, buffer.baseY - (this.scroll.get(app) ?? 0)) + y;
	}

	/**
	 * The selection in content rows, first point first. One whose text is gone
	 * (trimmed, cleared, or the app switched screens under it) ends here
	 * rather than attaching to whatever replaced it.
	 */
	private orderedSelection() {
		const selection = this.selection;
		if (!selection) return undefined;
		const app = this.selectedApp();
		const buffer = app
			? this.options.output.screens.get(app)?.term.buffer.active.type
			: undefined;
		const anchor = this.resolve(selection.anchor);
		const head = this.resolve(selection.head);
		if (
			anchor === undefined ||
			head === undefined ||
			buffer !== selection.buffer
		) {
			this.clearSelection();
			return undefined;
		}
		const a = { row: anchor, col: selection.anchor.col };
		const b = { row: head, col: selection.head.col };
		return a.row < b.row || (a.row === b.row && a.col <= b.col)
			? { start: a, end: b }
			: { start: b, end: a };
	}

	private copySelection(range: {
		start: { row: number; col: number };
		end: { row: number; col: number };
	}): void {
		const app = this.selectedApp();
		const nameWidth = this.overviewNameWidth();
		const lines = this.overviewLines();
		const buffer = app
			? this.options.output.screens.get(app)?.term.buffer.active
			: undefined;
		let text = "";
		for (let row = range.start.row; row <= range.end.row; row++) {
			// Whole lines, not what fits on screen: a cut-off line copies in full.
			const full = app
				? (buffer?.getLine(row)?.translateToString(true) ?? "")
				: lines[row]
					? overviewPlainLine(lines[row] as OutputLine, nameWidth)
					: "";
			const from = row === range.start.row ? range.start.col : 0;
			// Ending at the pane's edge (where a cut-off line shows "…") means
			// the rest of the line too.
			const toEdge = range.end.col >= this.paneSize().cols - 1;
			const piece =
				row === range.end.row && !toEdge
					? Bun.sliceAnsi(full, from, range.end.col + 1)
					: Bun.sliceAnsi(full, from);
			const wraps = app && buffer?.getLine(row + 1)?.isWrapped;
			text += row === range.end.row || wraps ? piece : `${piece.trimEnd()}\n`;
		}
		text = text.trimEnd();
		if (!text) return;
		const where = this.options.copy
			? this.options.copy(text)
			: copyToClipboard(text, (sequence) => this.write(sequence));
		const count = range.end.row - range.start.row + 1;
		this.message = `Copied ${count === 1 ? `${text.length} characters` : `${count} lines`}${where === "terminal" ? " (through the terminal)" : ""}`;
	}

	private select(index: number): void {
		if (index !== this.selected) this.clearSelection();
		this.selected = index;
		const app = this.selectedApp();
		if (app) this.unread.delete(app);
	}

	private scrollBy(lines: number): void {
		const app = this.selectedApp();
		const key = app ?? "";
		const max = app
			? (this.options.output.screens.get(app)?.term.buffer.active.baseY ?? 0)
			: Math.max(0, this.overviewLines().length - this.paneSize().rows);
		this.scroll.set(
			key,
			Math.min(max, Math.max(0, (this.scroll.get(key) ?? 0) + lines)),
		);
	}

	private open(url: string): void {
		this.message = openUrl(url) ? `Opened ${url}` : `Could not open ${url}`;
	}

	private async openLog(app: string | undefined): Promise<void> {
		const path = this.options.logPath?.(app);
		if (!path) {
			this.message = "No log file";
			return;
		}
		this.options.output.logs?.flush();
		if (!app) {
			this.open(path);
			return;
		}
		// Hand the terminal to the pager, then take it back. The pager reads
		// the keys meanwhile: this process stops reading stdin altogether.
		this.suspended = true;
		clearTimeout(this.escTimer);
		this.pending = "";
		this.stdin.off("data", this.onInput);
		this.stdin.pause();
		this.restoreTerminal();
		const pager = (process.env.PAGER || "less +G").split(" ");
		try {
			this.pager = Bun.spawn([...pager, path], {
				stdio: ["inherit", "inherit", "inherit"],
			});
			await this.pager.exited;
		} catch {
			this.message = `Could not run ${pager[0]}`;
		} finally {
			this.pager = undefined;
			this.suspended = false;
			// The run may have ended while the pager was open: then the
			// terminal is the user's again and must stay restored.
			if (this.active) {
				this.write(ENTER_SCREEN);
				this.stdin.setRawMode?.(true);
				this.stdin.on("data", this.onInput);
				this.stdin.resume();
				this.frame = [];
				this.invalidate();
			}
		}
	}

	private urlTargets(): [string, string][] {
		return this.options.apps.flatMap((app) => {
			const url = this.options.urlFor(app);
			return url ? [[app, url] as [string, string]] : [];
		});
	}

	private liveActions(): (TuiAction & { url: string })[] {
		return (this.options.actions ?? []).flatMap((action) => {
			const url = this.options.output.captured
				.get(action.app)
				?.get(action.open);
			return url ? [{ ...action, url }] : [];
		});
	}

	private overviewNameWidth(): number {
		return Math.max(8, ...this.options.apps.map((name) => name.length));
	}

	private overviewLines(): OutputLine[] {
		return this.errorsOnly
			? this.lines.filter((line) => line.level !== undefined)
			: this.lines;
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	private render(): void {
		if (!this.active || this.suspended || !this.dirty) return;
		this.dirty = false;
		this.lastRender = performance.now();
		const { cols, rows } = this.size();
		const side = this.sidebarWidth();
		const pane = this.paneSize();
		const app = this.selectedApp();
		const { output } = this.options;

		for (const [name, screen] of output.screens)
			if (!this.hooked.has(screen)) {
				this.hooked.add(screen);
				screen.term.onWriteParsed(() => {
					if (this.selectedApp() === name) this.invalidate();
				});
			}

		const sidebar = renderSidebar(
			this.options.apps.map((name) => {
				const state = output.states.get(name);
				return {
					name,
					state: state?.state,
					detail: state?.detail,
					unread: this.unread.has(name),
				};
			}),
			this.selected,
			side,
			pane.rows,
		);
		const main = this.renderMain(app, pane);
		const next = [
			this.header(app, side, cols),
			...sidebar.map(
				(left, index) => `${left}${pc.dim("│")}${main[index] ?? ""}`,
			),
			this.footer(app, cols),
		].slice(0, rows);

		let out = "";
		next.forEach((row, index) => {
			if (this.frame[index] !== row) out += `\u001b[${index + 1};1H${row}`;
		});
		this.frame = next;

		// The app's own cursor, where it is, while keys go to it.
		const screen = app ? output.screens.get(app) : undefined;
		if (
			this.interacting &&
			screen?.cursorVisible &&
			(this.scroll.get(app ?? "") ?? 0) === 0
		) {
			const buffer = screen.term.buffer.active;
			out += `\u001b[${buffer.cursorY + 2};${side + 2 + buffer.cursorX}H\u001b[?25h`;
		} else out += "\u001b[?25l";
		this.write(out);
	}

	private renderMain(
		app: string | undefined,
		pane: { cols: number; rows: number },
	): string[] {
		const { output } = this.options;
		if (this.picker !== undefined) {
			const targets = this.urlTargets();
			const rows = [
				fit(pc.bold(" Open which app?"), pane.cols),
				...targets.map(([name, url], index) =>
					fit(
						`${index === this.picker ? pc.inverse(` ${name} `) : ` ${colorizeName(name)} `} ${pc.dim(url)}`,
						pane.cols,
					),
				),
			];
			while (rows.length < pane.rows) rows.push(" ".repeat(pane.cols));
			return rows;
		}
		if (!app)
			return this.highlight(
				renderOverview(this.overviewLines(), {
					width: pane.cols,
					height: pane.rows,
					scroll: this.scroll.get("") ?? 0,
					nameWidth: this.overviewNameWidth(),
				}),
				pane.cols,
			);
		const screen = output.screens.get(app);
		if (!screen) {
			const tail = output.tail(app).slice(-pane.rows);
			const rows = tail.map((line) => fit(line, pane.cols));
			while (rows.length < pane.rows) rows.unshift(" ".repeat(pane.cols));
			return rows;
		}
		const buffer = screen.term.buffer.active;
		const start = Math.max(0, buffer.baseY - (this.scroll.get(app) ?? 0));
		const cell = buffer.getNullCell();
		return this.highlight(
			Array.from({ length: pane.rows }, (_, y) =>
				renderScreenRow(buffer.getLine(start + y), pane.cols, cell),
			),
			pane.cols,
		);
	}

	/** The pane's rows with the selection, if it is in this pane, reversed. */
	private highlight(rows: string[], width: number): string[] {
		if (this.selection?.pane !== (this.selectedApp() ?? "")) return rows;
		const range = this.orderedSelection();
		if (!range) return rows;
		return rows.map((row, y) => {
			const content = this.contentRow(y);
			if (
				content === undefined ||
				content < range.start.row ||
				content > range.end.row
			)
				return row;
			const from = content === range.start.row ? range.start.col : 0;
			const to = content === range.end.row ? range.end.col + 1 : width;
			return highlightColumns(row, from, to, width);
		});
	}

	private header(app: string | undefined, side: number, cols: number): string {
		const left = fit(pc.inverse(pc.bold(" buncargo ")), side);
		let title: string;
		if (!app) {
			const scroll = this.scroll.get("") ?? 0;
			title = ` Overview${this.errorsOnly ? pc.yellow("  errors and warnings only") : ""}${scroll > 0 ? pc.yellow(`  ↑ ${scroll} lines · End to follow`) : ""}`;
		} else {
			const url = this.options.urlFor(app);
			const scroll = this.scroll.get(app) ?? 0;
			title = ` ${colorizeName(app)}${url ? `  ${pc.cyan(url)}` : ""}${scroll > 0 ? pc.yellow(`  ↑ ${scroll} lines · End to follow`) : ""}${this.interacting ? pc.green("  keys go to the app · Esc to leave") : ""}`;
		}
		return `${left}${pc.dim("│")}${fit(title, cols - side - 1)}`;
	}

	private footer(app: string | undefined, cols: number): string {
		if (this.message) return fit(` ${this.message}`, cols);
		if (this.interacting)
			return fit(
				` ${pc.green("●")} interacting with ${app} · ${pc.bold("Esc")} back to buncargo`,
				cols,
			);
		const hints = app
			? [
					"↑↓ select",
					"enter interact",
					...(this.options.urlFor(app) ? ["o open"] : []),
					"r restart",
					"l log",
					"esc overview",
					"q quit",
				]
			: ["↑↓ select", "e errors", "o open", "l logs", "q quit"];
		return renderFooter(
			hints.map((hint) => {
				const [key, ...rest] = hint.split(" ");
				return `${pc.bold(key ?? "")} ${rest.join(" ")}`;
			}),
			this.liveActions(),
			cols,
		);
	}
}
