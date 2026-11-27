import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { format } from "node:util";
import type { IMarker } from "@xterm/headless";
import { clamp, getErrorMessage, typedSwitch } from "hanzio";
import pc from "picocolors";
import { openUrl } from "../../core/open-url";
import type { AppScreen } from "../../core/process/app-screen";
import {
	createErrorFilter,
	defaultScreenSize,
	type OutputLine,
	type RunOutput,
} from "../../core/process/run-output";
import { splitCommandLine } from "../../core/shell-quote";
import { colorizeName } from "../../core/style";
import { copyToClipboard } from "./clipboard";
import {
	fit,
	highlightColumns,
	highlightMatches,
	joinRows,
	layoutOverview,
	layoutSidebar,
	type OverviewRowMap,
	overviewPlainLine,
	renderFooter,
	renderInfo,
	renderScreenRow,
	wrapJoint,
} from "./render";

// The run's terminal UI: a sidebar with the Overview and every app, and a
// main pane with either all apps' lines interleaved or one app's own
// terminal. Each app runs under its own pseudo-terminal sized to the pane
// (`RunOutput.screenSize`), so a full-screen app draws itself correctly
// here while the others keep running one keypress away.
//
// It owns the terminal while it runs: raw mode, the alternate screen, a hidden
// cursor, and stdout/console. Anything else printing would scribble over the
// frame, so it lands in the Overview as a `buncargo` line instead. `stop()`
// gives all of that back, and so does process exit, whatever caused it.

/** A key an app or integration declared (`AppConfig.actions`). */
export interface TuiAction {
	app: string;
	key: string;
	label: string;
	/** Capture name whose value is the URL to open. */
	open: string;
}

interface RunTuiOptions {
	output: RunOutput;
	apps: readonly string[];
	/** Subset of `apps` entries that are finite reactive tasks (shown with `r run` and no interact mode). */
	taskNames?: ReadonlySet<string>;
	/**
	 * Subset of `apps` the run left out: listed as not started until `r` or `s`
	 * starts one (`RunOutput.startApp`), then shown like any other app.
	 */
	leftOut?: ReadonlySet<string>;
	/** Active profile name, shown subtly in the top-left header when set. */
	profile?: string;
	/** Live environment summary lines shown by the `i` / `?` info overlay. */
	info?(): readonly string[];
	/** The URL `o` opens and `y` copies for an app (what BuncargoBar's open does). */
	urlFor(app: string): string | undefined;
	actions?: readonly TuiAction[];
	/** The log file of an app, or the run's log directory for the Overview. */
	logPath?(app: string | undefined): string | undefined;
	/** Quit the run (`q`). */
	quit(): void;
	stdin?: NodeJS.ReadStream;
	stdout?: NodeJS.WriteStream;
	/** Where a selection or URL copy goes. Default: the system clipboard. */
	copy?(text: string): "clipboard" | "terminal";
}

const SIDEBAR_MIN = 18;
const SIDEBAR_MAX = 32;
const FRAME_MS = 33;
const RESIZE_DEBOUNCE_MS = 60;
const MESSAGE_TTL_MS = 3_000;
const OVERVIEW_LINES = 10_000;
/** Slack before trimming Overview lines, avoiding O(N) `shift()` per line. */
const OVERVIEW_TRIM_SLACK = 500;
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
/** DEC Mode 2026 synchronized output: prevents flicker during fast scroll/resize. */
const SYNC_START = "\u001b[?2026h";
const SYNC_END = "\u001b[?2026l";
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

type SigintListener = (signal: "SIGINT") => void;

/**
 * Route SIGINT to `onInterrupt` alone until the returned release, which puts
 * the process's own listeners back. The pager gets the terminal in cooked
 * mode, so Ctrl-C there signals this whole process group: without this it
 * would end the run instead of closing the pager. Bun signals the listeners
 * directly, so they have to be moved aside rather than filtered.
 */
function holdInterrupts(onInterrupt: () => void): () => void {
	// Each held listener, and whether it was added with `once`.
	const held = new Map<SigintListener, boolean>(
		process.listeners("SIGINT").map((listener) => [listener, false]),
	);
	process.removeAllListeners("SIGINT");
	process.on("SIGINT", onInterrupt);
	const real = {
		on: process.on,
		addListener: process.addListener,
		prependListener: process.prependListener,
		once: process.once,
		prependOnceListener: process.prependOnceListener,
		off: process.off,
		removeListener: process.removeListener,
	};
	// A listener added meanwhile is held too: it would otherwise fire on the
	// Ctrl-C that closes the pager.
	const hold = (method: keyof typeof real, once: boolean) =>
		function (
			this: NodeJS.Process,
			event: string | symbol,
			listener: SigintListener,
		) {
			if (event !== "SIGINT") return real[method].call(this, event, listener);
			held.set(listener, once);
			return this;
		} as typeof process.on;
	// A listener its owner removes meanwhile (the run ended while the pager
	// was open) is not put back: removing one that is held aside would
	// otherwise do nothing, and the release would revive it.
	const forget = function (
		this: NodeJS.Process,
		event: string | symbol,
		listener: SigintListener,
	) {
		if (event === "SIGINT") held.delete(listener);
		return real.removeListener.call(this, event, listener);
	} as typeof process.removeListener;
	Object.assign(process, {
		on: hold("on", false),
		addListener: hold("addListener", false),
		prependListener: hold("prependListener", false),
		once: hold("once", true),
		prependOnceListener: hold("prependOnceListener", true),
		off: forget,
		removeListener: forget,
	});
	let released = false;
	return () => {
		if (released) return;
		released = true;
		Object.assign(process, real);
		process.off("SIGINT", onInterrupt);
		for (const [listener, once] of held)
			if (once) process.once("SIGINT", listener);
			else process.on("SIGINT", listener);
	};
}

/**
 * Where keys go: buncargo's own bindings, the selected app (interact mode),
 * the "open/copy which app?" list, live search input, or the info overlay.
 * One value, so no two can be on at once.
 */
type InputMode =
	| { kind: "navigate" }
	| { kind: "interact" }
	| { kind: "picker"; index: number; intent: "open" | "copy" }
	| { kind: "search"; previousScroll: number }
	| { kind: "info"; scroll: number };

const DEFAULT_KEYBINDING_INFO: readonly string[] = [
	"",
	pc.bold(" Keybindings"),
	`  ${pc.bold("↑↓ / j k")}      Select Overview, app, or task`,
	`  ${pc.bold("0..9")}          Jump directly to Overview (0) or pane 1..9`,
	`  ${pc.bold("Enter")}         Interact with selected app (${pc.bold("Esc")} / ${pc.bold("Ctrl-]")} to leave)`,
	`  ${pc.bold("/")}             Search logs (${pc.bold("n")}/${pc.bold("N")} next/prev match, ${pc.bold("Esc")} clear)`,
	`  ${pc.bold("e")}             Overview: toggle errors & warnings (with full blocks)`,
	`  ${pc.bold("w")}             Overview: toggle line wrapping`,
	`  ${pc.bold("r")}             Restart selected app (start off app, or run reactive task)`,
	`  ${pc.bold("s")}             Stop / start selected app (or cancel running task)`,
	`  ${pc.bold("c")}             Clear current pane`,
	`  ${pc.bold("o / y")}         Open / copy app URL (picker in Overview)`,
	`  ${pc.bold("l")}             Open log in $PAGER (merged log in Overview)`,
	`  ${pc.bold("b / [")}         Collapse or expand the sidebar`,
	`  ${pc.bold("Ctrl-U / D")}    Scroll half-page up / down (${pc.bold("g")}/${pc.bold("G")}, ${pc.bold("Home")}/${pc.bold("End")})`,
	`  ${pc.bold("i / ?")}         Toggle this environment info overlay`,
	`  ${pc.bold("q / Ctrl-C")}    Quit the run`,
];

export class RunTui {
	private selected = 0;
	private mode: InputMode = { kind: "navigate" };
	private errorsOnly = false;
	private wrapOverview = false;
	private sidebarHidden = false;
	private sidebarOffset = 0;
	private searchQuery = "";
	private searchMatchRows: number[] = [];
	private searchMatchCursor = -1;
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
	private messageTimer?: ReturnType<typeof setTimeout>;
	private resizeTimer?: ReturnType<typeof setTimeout>;
	/** How far each pane is scrolled back: the Overview's ("") in lines. */
	private scroll = new Map<string, number>();
	/**
	 * An app pane scrolled back is held by a marker on its top row, so new
	 * output (and a trimmed scrollback) does not move what it shows.
	 */
	private anchors = new Map<string, IMarker>();
	private unread = new Set<string>();
	private lines: OutputLine[] = [];
	/** Per-app stateful block/stack filters so `e` keeps structured error blocks whole. */
	private errorFilters = new Map<string, (text: string) => boolean>();
	private errorMatched = new WeakSet<OutputLine>();
	private filteredOverviewCache?: OutputLine[];
	/** Cached snapshot of `i`/`?` info lines so log chatter never runs sync disk I/O. */
	private cachedInfoLines?: readonly string[];
	private frame: string[] = [];
	private dirty = true;
	private timer?: ReturnType<typeof setTimeout>;
	private lastRender = 0;
	private active = false;
	private suspended = false;
	private pager?: Bun.Subprocess;
	private pagerTempPath?: string;
	/** Gives the run its own SIGINT listeners back once the pager is closed. */
	private releaseInterrupts?: () => void;
	private hooked = new WeakSet<object>();
	private writeDisposables: Array<{ dispose(): void }> = [];
	private unsubscribe?: () => void;
	private restoreOutput?: () => void;
	private readonly stdin: NodeJS.ReadStream;
	private readonly stdout: NodeJS.WriteStream;
	private readonly appSet: ReadonlySet<string>;
	private readonly taskSet: ReadonlySet<string>;
	private readonly leftOut: ReadonlySet<string>;
	private readonly onInput = (data: Buffer | string) =>
		this.input(String(data));
	private readonly onResize = () => this.layout(true);
	/**
	 * A crash gives the terminal back before Bun prints the error, or leaving
	 * the alternate screen at exit would erase it. A rejection has no monitor
	 * event: restore, then rethrow, so it still prints and exits 1.
	 */
	private readonly onExit = () => this.stop();
	private readonly onRejection = (reason: unknown) => {
		this.stop();
		throw reason;
	};

	constructor(private readonly options: RunTuiOptions) {
		this.stdin = options.stdin ?? process.stdin;
		this.stdout = options.stdout ?? process.stdout;
		this.appSet = new Set(options.apps);
		this.taskSet = options.taskNames ?? new Set();
		this.leftOut = options.leftOut ?? new Set();
	}

	/** Left out by the run, and not started since. */
	private notStarted(app: string | undefined): boolean {
		return (
			app !== undefined &&
			this.leftOut.has(app) &&
			!this.options.output.states.has(app)
		);
	}

	private startLeftOut(app: string): void {
		const start = this.options.output.startApp;
		if (!start) {
			this.flash(`${app} can start once the run's own apps are up`);
			return;
		}

		this.flash(`Starting ${app}…`);
		void start(app).then(
			(reply) => {
				if (!this.active) return;
				// The rest of a refusal is in the Overview.
				if (reply.status === "refused") {
					const [firstLine] = reply.reason.split("\n", 1);
					this.flash(firstLine ?? "");
				} else if (reply.apps.length === 0) {
					this.flash(`${app} is already starting`);
				} else if (reply.apps.length > 1) {
					this.flash(`Starting ${reply.apps.join(", ")}…`);
				}
			},
			(error: unknown) => {
				if (!this.active) return;
				this.flash(`${app} could not start: ${getErrorMessage(error)}`);
			},
		);
	}

	/** Pane size every app's terminal gets (clamped to a usable PTY minimum). */
	paneSize(): { cols: number; rows: number } {
		const render = this.renderPaneSize();
		return {
			cols: Math.max(20, render.cols),
			rows: Math.max(4, render.rows),
		};
	}

	/** Exact available main-pane area inside the current terminal frame. */
	private renderPaneSize(): { cols: number; rows: number } {
		const { cols, rows } = this.size();
		const side = this.effectiveSidebarWidth();
		const gutter = side > 0 ? 1 : 0;
		return {
			cols: Math.max(1, cols - side - gutter),
			rows: Math.max(0, rows - 2),
		};
	}

	private hookScreen(name: string, screen: AppScreen): void {
		if (this.hooked.has(screen)) return;
		this.hooked.add(screen);
		this.writeDisposables.push(
			screen.term.onWriteParsed(() => {
				if (this.selectedApp() === name && this.mode.kind !== "info") {
					this.invalidate();
				}
			}),
		);
	}

	start(): void {
		// Twice would subscribe twice, and capture the captured writes as the
		// terminal's own.
		if (this.active) return;

		const { output } = this.options;
		output.screenSize = () => this.paneSize();
		for (const [name, screen] of output.screens) this.hookScreen(name, screen);

		this.unsubscribe = output.subscribe({
			line: (line) => {
				// Overview renders `line.text`, never `line.raw`; dropping `raw` cuts
				// retained string memory roughly in half across 10k buffered lines.
				const stored = line.raw ? { ...line, raw: "" } : line;
				const isErrorOrWarn = this.classifyOverviewError(stored);
				if (isErrorOrWarn) this.errorMatched.add(stored);

				this.lines.push(stored);
				if (this.lines.length >= OVERVIEW_LINES + OVERVIEW_TRIM_SLACK) {
					this.lines = this.lines.slice(-OVERVIEW_LINES);
					this.filteredOverviewCache = undefined;
					const maxOverview = this.maxScrollFor(undefined);
					const currentOverview = this.scroll.get("") ?? 0;
					if (currentOverview > maxOverview) {
						this.scroll.set("", maxOverview);
					}
				} else if (
					this.filteredOverviewCache &&
					this.matchesOverviewFilter(stored)
				) {
					this.filteredOverviewCache.push(stored);
				}

				// Only an app has a sidebar row to mark; buncargo's own lines do not.
				const selected = this.selectedApp();
				const unread =
					line.level === "error" &&
					selected !== line.app &&
					this.appSet.has(line.app);
				const unreadChanged = unread && !this.unread.has(line.app);
				if (unreadChanged) this.unread.add(line.app);

				// Keep a scrolled-back Overview where it is.
				const overview = this.scroll.get("") ?? 0;
				const isShown = this.matchesOverviewFilter(stored);
				if (overview > 0 && isShown) this.scroll.set("", overview + 1);

				if (this.mode.kind === "info") {
					if (unreadChanged && this.effectiveSidebarWidth() > 0) {
						this.invalidate();
					}
					return;
				}

				// Avoid redrawing an unrelated app's xterm pane when a background app prints.
				const viewingOverview = selected === undefined;
				const selectedScreen = selected
					? output.screens.get(selected)
					: undefined;
				const viewingSelectedNeedsDraw =
					selected === line.app &&
					(!selectedScreen || !this.hooked.has(selectedScreen));
				if (viewingOverview || viewingSelectedNeedsDraw || unreadChanged) {
					this.invalidate();
				}
			},
			state: () => {
				if (this.mode.kind === "info") this.refreshInfoCache();
				this.invalidate();
			},
			capture: () => {
				if (this.mode.kind === "info") this.refreshInfoCache();
				this.invalidate();
			},
			screen: (name, screen) => {
				this.hookScreen(name, screen);
				if (this.selectedApp() === name && this.mode.kind !== "info") {
					this.invalidate();
				}
			},
		});
		this.captureOutput();
		this.active = true;

		this.write(ENTER_SCREEN);
		this.stdin.setRawMode?.(true);
		this.stdin.resume();
		this.stdin.on("data", this.onInput);
		this.stdout.on("resize", this.onResize);

		process.on("exit", this.onExit);
		process.on("uncaughtExceptionMonitor", this.onExit);
		process.on("unhandledRejection", this.onRejection);
		this.invalidate();
	}

	stop(): void {
		if (!this.active) return;
		this.active = false;

		// An open pager would hold the terminal past the run.
		this.pager?.kill();
		this.cleanupPagerTemp();
		this.releaseInterrupts?.();
		clearTimeout(this.timer);
		clearTimeout(this.escTimer);
		clearTimeout(this.messageTimer);
		clearTimeout(this.resizeTimer);
		this.unsubscribe?.();

		// Apps restarted from here on have no pane to be sized to.
		this.options.output.screenSize = defaultScreenSize;
		for (const anchor of this.anchors.values()) anchor.dispose();
		this.anchors.clear();
		for (const disposable of this.writeDisposables) disposable.dispose();
		this.writeDisposables = [];
		this.clearSelection();
		this.lines = [];
		this.errorFilters.clear();
		this.filteredOverviewCache = undefined;
		this.cachedInfoLines = undefined;
		this.frame = [];

		this.stdin.off("data", this.onInput);
		this.stdout.off("resize", this.onResize);
		process.off("exit", this.onExit);
		process.off("uncaughtExceptionMonitor", this.onExit);
		process.off("unhandledRejection", this.onRejection);

		this.restoreTerminal();
		this.restoreOutput?.();
		this.stdin.pause();
	}

	private classifyOverviewError(line: OutputLine): boolean {
		if (line.event) return line.level !== undefined;
		let filter = this.errorFilters.get(line.app);
		if (!filter) {
			filter = createErrorFilter({ includeWarnings: true });
			this.errorFilters.set(line.app, filter);
		}
		return filter(line.text);
	}

	private matchesOverviewFilter(line: OutputLine): boolean {
		if (this.errorsOnly && !this.errorMatched.has(line)) return false;
		if (!this.searchQuery) return true;
		const needle = this.searchQuery.toLowerCase();
		return (
			line.text.toLowerCase().includes(needle) ||
			line.app.toLowerCase().includes(needle)
		);
	}

	private flash(text: string, autoClear = true): void {
		clearTimeout(this.messageTimer);
		this.messageTimer = undefined;
		this.message = text;
		if (autoClear) {
			this.messageTimer = setTimeout(() => {
				this.messageTimer = undefined;
				if (this.message === text) {
					this.message = undefined;
					this.invalidate();
				}
			}, MESSAGE_TTL_MS);
			this.messageTimer.unref?.();
		}
		this.invalidate();
	}

	private clearMessage(): void {
		clearTimeout(this.messageTimer);
		this.messageTimer = undefined;
		this.message = undefined;
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
		for (const method of ["log", "info", "warn", "error", "debug"] as const) {
			console[method] = (...args: unknown[]) => log(format(...args));
		}

		this.restoreOutput = () => {
			process.stdout.write = saved.stdout;
			process.stderr.write = saved.stderr;
			for (const method of ["log", "info", "warn", "error", "debug"] as const) {
				console[method] = saved[method];
			}
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
		return clamp(longest + 14, SIDEBAR_MIN, SIDEBAR_MAX);
	}

	private effectiveSidebarWidth(): number {
		if (this.sidebarHidden) return 0;
		const desired = this.sidebarWidth();
		const { cols } = this.size();
		// Auto-hide sidebar on very narrow terminals so body rows never wrap/overflow.
		if (cols < SIDEBAR_MIN + 21) return 0;
		return Math.min(desired, cols - 21);
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

	private resizeScreens(): void {
		const pane = this.paneSize();
		for (const screen of this.options.output.screens.values()) {
			screen.resize(pane.cols, pane.rows);
		}
	}

	private layout(full: boolean, immediate = false): void {
		clearTimeout(this.resizeTimer);
		if (immediate) {
			this.resizeScreens();
		} else {
			// Debounce xterm buffer reflows and child SIGWINCH storms during window drags.
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = undefined;
				if (!this.active) return;
				this.resizeScreens();
				this.frame = [];
				this.invalidate();
			}, RESIZE_DEBOUNCE_MS);
			this.resizeTimer.unref?.();
		}

		if (full) this.frame = [];
		this.invalidate();
	}

	private input(data: string): void {
		if (this.suspended) return;
		clearTimeout(this.escTimer);

		data = this.pending + data;
		const partial = PARTIAL.exec(data);
		this.pending = partial?.[0] ?? "";
		this.keys(data.slice(0, partial?.index).match(KEY) ?? []);

		// Only time tells a lone Esc from the start of a longer key.
		if (this.pending) {
			this.escTimer = setTimeout(() => {
				const key = this.pending;
				this.pending = "";
				if (this.active && !this.suspended) this.keys([key]);
			}, ESC_WAIT_MS);
		}
	}

	private keys(keys: readonly string[]): void {
		// Keys typed into the app, sent in one write when a non-typed key or the end arrives.
		let typed = "";
		const send = () => {
			const app = this.selectedApp();
			if (typed && app) {
				// Typing answers what is live: back to the bottom, where the
				// app's cursor is.
				this.scrollTo(app, 0);
				this.options.output.screens.get(app)?.input(typed);
			}
			typed = "";
		};
		for (const key of keys) {
			if (this.suspended) break;
			const mouse = MOUSE.exec(key);
			// Mouse reports are ours (the wheel scrolls the pane): an app that
			// never asked for them must not receive them as typed input.
			if (mouse) {
				if (this.mode.kind !== "picker") this.mouse(mouse);
				continue;
			}
			// Any key, in any mode, ends what the last one left on screen.
			this.clearMessage();
			this.clearSelection();
			if (this.mode.kind !== "interact") {
				this.key(key);
				if (this.suspended) break;
			} else if (key === ESC || key === LEAVE) {
				send();
				this.mode = { kind: "navigate" };
			} else {
				typed += key;
			}
		}

		send();
		this.invalidate();
	}

	private openInfo(): void {
		this.refreshInfoCache();
		this.mode = { kind: "info", scroll: 0 };
	}

	private closeInfo(): void {
		this.cachedInfoLines = undefined;
		this.mode = { kind: "navigate" };
	}

	private refreshInfoCache(): void {
		const envLines = this.options.info?.() ?? [];
		this.cachedInfoLines = [...envLines, ...DEFAULT_KEYBINDING_INFO];
	}

	private key(key: string): void {
		const app = this.selectedApp();
		const count = this.options.apps.length + 1;

		const handled = typedSwitch(this.mode, "kind", {
			interact: () => true,
			picker: ({ index, intent }) => {
				const targets = this.urlTargets();
				if (key === "\u001b[A" || key === "k") {
					this.mode = {
						kind: "picker",
						index: Math.max(0, index - 1),
						intent,
					};
				} else if (key === "\u001b[B" || key === "j") {
					this.mode = {
						kind: "picker",
						index: Math.min(targets.length - 1, index + 1),
						intent,
					};
				} else {
					// Enter acts on the highlighted app; any other key closes the list.
					const target = key === "\r" ? targets[index] : undefined;
					this.mode = { kind: "navigate" };
					if (target) {
						if (intent === "copy") this.copyUrl(target[0], target[1]);
						else this.open(target[1]);
					}
				}
				return true;
			},
			search: ({ previousScroll }) => {
				if (key === "\r") {
					this.mode = { kind: "navigate" };
				} else if (key === ESC || key === "\u0003") {
					this.mode = { kind: "navigate" };
					this.clearSearch();
					const max = this.maxScrollFor(app);
					this.scrollTo(app ?? "", clamp(previousScroll, 0, max));
				} else if (key === "\u007f" || key === "\b") {
					this.updateSearch(this.searchQuery.slice(0, -1), app);
				} else if (key === "\u0015") {
					this.updateSearch("", app);
				} else if (key.length === 1 && key >= " " && key !== "\u007f") {
					// Ignore escape sequences and control characters in search input.
					this.updateSearch(this.searchQuery + key, app);
				}
				return true;
			},
			info: ({ scroll }) => {
				const paneRows = Math.max(1, this.renderPaneSize().rows);
				const maxScroll = Math.max(0, this.infoLines().length - paneRows);
				const half = Math.max(1, Math.floor(paneRows / 2));
				if (key === ESC || key === "i" || key === "?" || key === "q") {
					this.closeInfo();
				} else if (key === "\u0003") {
					this.options.quit();
				} else if (key === "\u001b[A" || key === "k") {
					this.mode = { kind: "info", scroll: Math.max(0, scroll - 1) };
				} else if (key === "\u001b[B" || key === "j") {
					this.mode = {
						kind: "info",
						scroll: Math.min(maxScroll, scroll + 1),
					};
				} else if (key === "\u001b[5~" || key === "\u0015") {
					this.mode = { kind: "info", scroll: Math.max(0, scroll - half) };
				} else if (key === "\u001b[6~" || key === "\u0004") {
					this.mode = {
						kind: "info",
						scroll: Math.min(maxScroll, scroll + half),
					};
				} else if (
					key === "\u001b[H" ||
					key === "\u001bOH" ||
					key === "\u001b[1~" ||
					key === "g"
				) {
					this.mode = { kind: "info", scroll: 0 };
				} else if (
					key === "\u001b[F" ||
					key === "\u001bOF" ||
					key === "\u001b[4~" ||
					key === "G"
				) {
					this.mode = { kind: "info", scroll: maxScroll };
				}
				return true;
			},
			navigate: () => false,
		});
		if (handled) return;

		const visibleRows = Math.max(1, this.renderPaneSize().rows);
		const halfPage = Math.max(1, Math.floor(visibleRows / 2));

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
				if (this.searchQuery) {
					this.clearSearch();
				} else {
					this.select(0);
				}
				return;
			case "\r": {
				const canInteract =
					app !== undefined &&
					!this.taskSet.has(app) &&
					this.options.output.screens.has(app);
				if (canInteract) this.mode = { kind: "interact" };
				return;
			}
			case "\u001b[5~":
				this.scrollBy(Math.max(1, visibleRows - 1));
				return;
			case "\u001b[6~":
				this.scrollBy(-Math.max(1, visibleRows - 1));
				return;
			case "\u0015": // Ctrl-U: half-page up
				this.scrollBy(halfPage);
				return;
			case "\u0004": // Ctrl-D: half-page down
				this.scrollBy(-halfPage);
				return;
			// End: back to the live bottom. Home: the oldest line kept.
			case "\u001b[F":
			case "\u001bOF":
			case "\u001b[4~":
				this.scrollTo(app ?? "", 0);
				return;
			case "\u001b[H":
			case "\u001bOH":
			case "\u001b[1~":
				this.scrollBy(Number.MAX_SAFE_INTEGER);
				return;
			case "/":
				this.mode = {
					kind: "search",
					previousScroll: this.scrollOf(app ?? ""),
				};
				return;
			case "?":
				this.openInfo();
				return;
			case "[":
				this.toggleSidebar();
				return;
			case "e":
				if (!app) {
					this.errorsOnly = !this.errorsOnly;
					this.filteredOverviewCache = undefined;
					this.scroll.set("", 0);
				}
				return;
			case "o":
				this.openOrPickUrl(app, "open");
				return;
			case "r":
				if (app && this.notStarted(app)) {
					this.startLeftOut(app);
				} else if (app) {
					this.triggerRestart(app);
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

		// App-declared actions (e.g. Shopify `p` preview, `g` GraphiQL) win over
		// convenience keys so user configs never break.
		const action = this.liveActions().find((entry) => entry.key === key);
		if (action) {
			this.open(action.url);
			return;
		}

		if (key >= "0" && key <= "9") {
			const idx = Number(key);
			if (idx < count) this.select(idx);
			return;
		}

		switch (key) {
			case "s":
				if (app) this.toggleStopStart(app);
				return;
			case "c":
				this.clearPane(app);
				return;
			case "y":
				this.openOrPickUrl(app, "copy");
				return;
			case "w":
				if (!app) {
					this.wrapOverview = !this.wrapOverview;
					this.flash(this.wrapOverview ? "Line wrap on" : "Line wrap off");
				}
				return;
			case "b":
				this.toggleSidebar();
				return;
			case "i":
				this.openInfo();
				return;
			case "g":
				this.scrollBy(Number.MAX_SAFE_INTEGER);
				return;
			case "G":
				this.scrollTo(app ?? "", 0);
				return;
			case "n":
				if (app && this.searchQuery) this.stepAppSearch(app, -1);
				return;
			case "N":
				if (app && this.searchQuery) this.stepAppSearch(app, 1);
				return;
		}
	}

	private toggleSidebar(): void {
		this.sidebarHidden = !this.sidebarHidden;
		this.clearSelection();
		this.layout(true, true);
	}

	private openOrPickUrl(
		app: string | undefined,
		intent: "open" | "copy",
	): void {
		if (app) {
			if (this.notStarted(app)) {
				this.flash(`${app} is not started; r or s starts it`);
				return;
			}
			const url = this.taskSet.has(app) ? undefined : this.options.urlFor(app);
			if (!url) {
				this.flash(`${app} has no URL`);
				return;
			}
			if (intent === "copy") this.copyUrl(app, url);
			else this.open(url);
			return;
		}

		const targets = this.urlTargets();
		if (targets.length === 0) {
			this.flash("No app has a URL yet");
			return;
		}
		const [onlyTarget] = targets;
		if (intent === "copy" && targets.length === 1 && onlyTarget) {
			this.copyUrl(onlyTarget[0], onlyTarget[1]);
			return;
		}
		this.mode = { kind: "picker", index: 0, intent };
	}

	private copyUrl(app: string, url: string): void {
		const where = this.options.copy
			? this.options.copy(url)
			: copyToClipboard(url, (sequence) => this.write(sequence));
		const route = where === "terminal" ? " (through the terminal)" : "";
		this.flash(`Copied ${app} URL: ${url}${route}`);
	}

	private triggerRestart(app: string, verbOverride?: string): void {
		const restart = this.options.output.controls?.restart;
		const isTask = this.taskSet.has(app);
		const verb = verbOverride ?? (isTask ? "Running" : "Restarting");
		const action = isTask ? "run" : "restart";
		if (!restart) {
			this.flash(`${app} cannot ${action} until the run has started its apps`);
			return;
		}

		this.flash(`${verb} ${app}…`);
		void restart(app).then(
			(replaced) => {
				if (!this.active) return;
				if (!replaced) {
					this.flash(
						isTask
							? `${app} cannot run right now`
							: `${app} cannot ${action} (reused from another terminal)`,
					);
				}
			},
			(error: unknown) => {
				if (!this.active) return;
				this.flash(`${app} failed to ${action}: ${getErrorMessage(error)}`);
			},
		);
	}

	private toggleStopStart(app: string): void {
		if (this.notStarted(app)) {
			this.startLeftOut(app);
			return;
		}

		const state = this.options.output.states.get(app);
		const isTask = this.taskSet.has(app);
		const isStopped = isTask
			? state?.detail !== "running"
			: state?.state === "stopped" || state?.state === "failed";

		if (isStopped) {
			this.triggerRestart(app, isTask ? "Running" : "Starting");
			return;
		}

		const stop = this.options.output.controls?.stop;
		if (!stop) {
			this.flash(`${app} cannot stop until the run has started its apps`);
			return;
		}

		this.flash(`Stopping ${app}…`, false);
		void stop(app).then(
			(stopped) => {
				if (!this.active) return;
				if (stopped) {
					this.flash(`Stopped ${app}`);
					return;
				}
				const latest = this.options.output.states.get(app)?.state;
				if (isTask) {
					this.flash(`${app} is not running`);
				} else if (latest === "starting") {
					this.flash(`${app} cannot stop while starting`);
				} else if (latest === "stopped") {
					this.flash(`${app} is already stopped`);
				} else {
					this.flash(`${app} cannot stop (reused from another terminal)`);
				}
			},
			(error: unknown) => {
				if (!this.active) return;
				this.flash(`Could not stop ${app}: ${getErrorMessage(error)}`);
			},
		);
	}

	private clearPane(app: string | undefined): void {
		this.clearSelection();
		if (!app) {
			this.lines = [];
			this.errorFilters.clear();
			this.filteredOverviewCache = undefined;
			this.scroll.set("", 0);
			this.flash("Cleared Overview");
			return;
		}
		if (this.notStarted(app)) {
			this.flash(`${app} is not started`);
			return;
		}

		const screen = this.options.output.screens.get(app);
		if (screen && screen.term.buffer.active.type !== "normal") {
			this.flash(`${app} uses full-screen mode and cannot be cleared`);
			return;
		}
		this.scrollTo(app, 0);
		if (screen) {
			void screen.clear().then((cleared) => {
				if (!this.active) return;
				if (!cleared) {
					this.flash(`${app} uses full-screen mode and cannot be cleared`);
				} else {
					this.invalidate();
				}
			});
		} else {
			this.options.output.clearTail(app);
		}
		this.searchMatchRows = [];
		this.searchMatchCursor = -1;
		this.flash(`Cleared ${app}`);
	}

	private clearSearch(): void {
		this.searchQuery = "";
		this.searchMatchRows = [];
		this.searchMatchCursor = -1;
		this.filteredOverviewCache = undefined;
	}

	private updateSearch(query: string, app: string | undefined): void {
		this.searchQuery = query;
		this.filteredOverviewCache = undefined;
		if (!app) {
			this.scroll.set("", 0);
			return;
		}
		this.refreshAppSearch(app, true);
	}

	private refreshAppSearch(app: string, jumpToLatest: boolean): void {
		if (!this.searchQuery) {
			this.searchMatchRows = [];
			this.searchMatchCursor = -1;
			return;
		}
		const screen = this.options.output.screens.get(app);
		const needle = this.searchQuery.toLowerCase();
		const matches: number[] = [];
		if (screen) {
			const buffer = screen.term.buffer.active;
			for (let row = 0; row < buffer.length; row++) {
				const text = buffer.getLine(row)?.translateToString(true) ?? "";
				if (text.toLowerCase().includes(needle)) matches.push(row);
			}
		} else {
			const tail = this.options.output.tail(app);
			for (const [row, line] of tail.entries()) {
				if (line.toLowerCase().includes(needle)) matches.push(row);
			}
		}
		this.searchMatchRows = matches;
		if (matches.length === 0) {
			this.searchMatchCursor = -1;
			return;
		}
		if (jumpToLatest || this.searchMatchCursor >= matches.length) {
			this.searchMatchCursor = matches.length - 1;
			const targetRow = matches[this.searchMatchCursor];
			if (targetRow !== undefined) this.scrollToAppRow(app, targetRow);
		}
	}

	private stepAppSearch(app: string, delta: number): void {
		this.refreshAppSearch(app, false);
		const total = this.searchMatchRows.length;
		if (total === 0) {
			this.flash(`No matches for "${this.searchQuery}"`);
			return;
		}
		this.searchMatchCursor =
			this.searchMatchCursor < 0
				? total - 1
				: (this.searchMatchCursor + delta + total) % total;
		const targetRow = this.searchMatchRows[this.searchMatchCursor];
		if (targetRow !== undefined) this.scrollToAppRow(app, targetRow);
	}

	private scrollToAppRow(app: string, row: number): void {
		const screen = this.options.output.screens.get(app);
		const paneRows = Math.max(1, this.renderPaneSize().rows);
		if (!screen) {
			const tailLen = this.options.output.tail(app).length;
			const maxScroll = Math.max(0, tailLen - paneRows);
			if (maxScroll === 0) {
				this.scrollTo(app, 0);
				return;
			}
			const desiredEnd = clamp(
				row + Math.ceil(paneRows / 2),
				paneRows,
				tailLen,
			);
			this.scrollTo(app, clamp(tailLen - desiredEnd, 0, maxScroll));
			return;
		}
		const buffer = screen.term.buffer.active;
		const desiredTop = clamp(row - Math.floor(paneRows / 2), 0, buffer.baseY);
		this.scrollTo(app, Math.max(0, buffer.baseY - desiredTop));
	}

	private infoLines(): readonly string[] {
		if (!this.cachedInfoLines) this.refreshInfoCache();
		return this.cachedInfoLines ?? DEFAULT_KEYBINDING_INFO;
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

		if (button === 64) {
			if (this.mode.kind === "info") {
				this.mode = {
					kind: "info",
					scroll: Math.max(0, this.mode.scroll - WHEEL_LINES),
				};
			} else {
				this.scrollBy(WHEEL_LINES);
			}
		} else if (button === 65) {
			if (this.mode.kind === "info") {
				const maxScroll = Math.max(
					0,
					this.infoLines().length - Math.max(1, this.renderPaneSize().rows),
				);
				this.mode = {
					kind: "info",
					scroll: Math.min(maxScroll, this.mode.scroll + WHEEL_LINES),
				};
			} else {
				this.scrollBy(-WHEEL_LINES);
			}
		} else if (button === 0 && pressed) {
			this.clearSelection();

			const side = this.effectiveSidebarWidth();
			if (side > 0 && column <= side) {
				if (this.mode.kind === "interact") return;
				const hit = layoutSidebar(
					this.sidebarEntries(),
					this.selected,
					side,
					this.renderPaneSize().rows,
					this.sidebarOffset,
				).hitAt(row - 2);
				if (hit !== undefined) {
					if (this.mode.kind === "info") this.closeInfo();
					else if (this.mode.kind === "search")
						this.mode = { kind: "navigate" };
					this.select(hit);
				}
				return;
			}

			if (this.mode.kind === "info") return;

			const end = this.endAt(column, row);
			const app = this.selectedApp();
			if (end) {
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
			}
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
			const isEmpty =
				range !== undefined &&
				range.start.row === range.end.row &&
				range.start.col === range.end.col;
			if (!range || isEmpty) this.clearSelection();
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
		const pane = this.renderPaneSize();
		if (pane.rows === 0) return undefined;
		const side = this.effectiveSidebarWidth();
		const paneStartCol = side > 0 ? side + 2 : 1;
		const x = clamp(column - paneStartCol, 0, pane.cols - 1);
		const y = clamp(row - 2, 0, pane.rows - 1);
		if (!this.selectedApp()) {
			const rowMap = this.overviewLayout(pane).rowMap;
			const mapped = rowMap[y] ?? rowMap.find((entry) => entry !== undefined);
			if (!mapped) return undefined;
			const plainCol = mapped.plainStart + Math.max(0, x - mapped.visualIndent);
			return {
				row: mapped.lineIndex,
				col:
					mapped.plainEnd < Number.MAX_SAFE_INTEGER
						? Math.min(
								plainCol,
								Math.max(mapped.plainStart, mapped.plainEnd - 1),
							)
						: plainCol,
			};
		}
		const content = this.contentRow(y);
		return content === undefined ? undefined : { row: content, col: x };
	}

	private overviewLayout(pane: { cols: number; rows: number }) {
		return layoutOverview(this.overviewLines(), {
			width: pane.cols,
			height: pane.rows,
			scroll: this.scroll.get("") ?? 0,
			nameWidth: this.overviewNameWidth(),
			wrap: this.wrapOverview,
			query: this.searchQuery || undefined,
		});
	}

	/** Absolute buffer row on screen row `y` of the selected app pane. */
	private contentRow(y: number): number | undefined {
		const app = this.selectedApp();
		if (!app) return undefined;
		const screen = this.options.output.screens.get(app);
		if (!screen) return undefined;
		const buffer = screen.term.buffer.active;
		return Math.max(0, buffer.baseY - this.scrollOf(app)) + y;
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

		// The app's terminal is the pane's size: the width it wraps at.
		const { cols } = this.paneSize();

		let text = "";
		// How the row being added continues the one above, when the app
		// wrapped it there with a real newline.
		let joint: string | undefined;
		for (let row = range.start.row; row <= range.end.row; row++) {
			// Whole lines, not what fits on screen: a cut-off line copies in full.
			const overviewLine = lines[row];
			let full = "";
			if (app) {
				full = buffer?.getLine(row)?.translateToString(true) ?? "";
			} else if (overviewLine) {
				full = overviewPlainLine(overviewLine, nameWidth);
			}

			const from = row === range.start.row ? range.start.col : 0;
			// Ending at the pane's edge (where a cut-off line shows "…") means
			// the rest of the line too; when Overview wrap is on, every column is visible.
			const toEdge =
				!app && this.wrapOverview ? false : range.end.col >= cols - 1;
			const piece =
				row === range.end.row && !toEdge
					? Bun.sliceAnsi(full, from, range.end.col + 1)
					: Bun.sliceAnsi(full, from);

			text = joint === undefined ? text + piece : joinRows(text, joint, piece);
			joint = undefined;
			if (row === range.end.row) break;

			// A row the terminal wrapped continues as it is. A line it had to
			// wrap came from an app that does not wrap its own output.
			const next = buffer?.getLine(row + 1);
			if (next?.isWrapped) continue;
			if (next && !buffer?.getLine(row)?.isWrapped)
				joint = wrapJoint(full, next.translateToString(true), cols);
			if (joint === undefined) text = `${text.trimEnd()}\n`;
		}

		text = text.trimEnd();
		if (!text) return;

		const where = this.options.copy
			? this.options.copy(text)
			: copyToClipboard(text, (sequence) => this.write(sequence));

		const count = text.split("\n").length;
		const size = count === 1 ? `${text.length} characters` : `${count} lines`;
		const route = where === "terminal" ? " (through the terminal)" : "";
		this.flash(`Copied ${size}${route}`);
	}

	private select(index: number): void {
		if (index !== this.selected) {
			this.clearSelection();
			this.clearSearch();
		}
		this.selected = index;
		const app = this.selectedApp();
		if (app) this.unread.delete(app);
	}

	private maxScrollFor(app: string | undefined): number {
		const visibleRows = Math.max(1, this.renderPaneSize().rows);
		if (!app) {
			const count = this.overviewLines().length;
			return this.wrapOverview
				? Math.max(0, count - 1)
				: Math.max(0, count - visibleRows);
		}
		const screen = this.options.output.screens.get(app);
		if (screen) return screen.term.buffer.active.baseY;
		return Math.max(0, this.options.output.tail(app).length - visibleRows);
	}

	private scrollBy(lines: number): void {
		const app = this.selectedApp();
		const key = app ?? "";
		const max = this.maxScrollFor(app);
		this.scrollTo(key, clamp(this.scrollOf(key) + lines, 0, max));
	}

	/** How many lines pane `key` ("" the Overview) is scrolled back now. */
	private scrollOf(key: string): number {
		const anchor = this.anchors.get(key);
		const buffer = this.options.output.screens.get(key)?.term.buffer.active;
		if (!anchor || !buffer) return this.scroll.get(key) ?? 0;

		// Its row was trimmed away: the oldest one kept is the closest.
		if (anchor.isDisposed) return buffer.baseY;
		return Math.max(0, buffer.baseY - anchor.line);
	}

	/**
	 * Scroll pane `key` to `lines` back. An app's pane is held by a marker on
	 * its top row, so it stays on the same text while the app prints; the
	 * Overview's lines are counted as they arrive instead (`start()`).
	 */
	private scrollTo(key: string, lines: number): void {
		this.anchors.get(key)?.dispose();
		this.anchors.delete(key);
		this.scroll.set(key, lines);

		const term = this.options.output.screens.get(key)?.term;
		const buffer = term?.buffer.active;
		if (!term || !buffer || lines === 0 || buffer.type === "alternate") return;

		const top = buffer.baseY - lines;
		const anchor = term.registerMarker(top - (buffer.baseY + buffer.cursorY));
		if (anchor) this.anchors.set(key, anchor);
	}

	private open(url: string): void {
		this.flash(openUrl(url) ? `Opened ${url}` : `Could not open ${url}`);
	}

	private buildMergedOverviewLog(dir: string): string | undefined {
		if (!existsSync(dir)) return undefined;
		let files: string[];
		try {
			files = readdirSync(dir)
				.filter((name) => name.endsWith(".log"))
				.sort();
		} catch {
			return undefined;
		}
		if (files.length === 0) return undefined;

		const entries: Array<{ time: string; line: string }> = [];
		const nameWidth = this.overviewNameWidth();
		for (const file of files) {
			const appName = file.slice(0, -".log".length);
			let content: string;
			try {
				content = readFileSync(join(dir, file), "utf8");
			} catch {
				continue;
			}
			for (const raw of content.split("\n")) {
				if (!raw) continue;
				const space = raw.indexOf(" ");
				if (space <= 0) continue;
				const iso = raw.slice(0, space);
				const text = raw.slice(space + 1);
				entries.push({
					time: iso,
					line: `${iso.slice(11, 19)} ${appName.padEnd(nameWidth)}  ${text}`,
				});
			}
		}
		if (entries.length === 0) return undefined;

		entries.sort((a, b) => a.time.localeCompare(b.time));
		const tmpPath = join(dir, `.overview-${process.pid}.tmp`);
		try {
			writeFileSync(
				tmpPath,
				`${entries.map((entry) => entry.line).join("\n")}\n`,
			);
			return tmpPath;
		} catch {
			return undefined;
		}
	}

	private cleanupPagerTemp(): void {
		const path = this.pagerTempPath;
		if (!path) return;
		this.pagerTempPath = undefined;
		try {
			rmSync(path, { force: true });
		} catch {
			// Best-effort temp cleanup.
		}
	}

	private async openLog(app: string | undefined): Promise<void> {
		if (this.suspended) return;
		const path = this.options.logPath?.(app);
		if (!path) {
			this.flash("No log file");
			return;
		}

		this.options.output.logs?.flush();
		let pagerPath = path;
		if (!app) {
			const merged = this.buildMergedOverviewLog(path);
			if (!merged) {
				this.open(path);
				return;
			}
			pagerPath = merged;
			this.pagerTempPath = merged;
		}

		// Hand the terminal to the pager, then take it back. The pager reads
		// the keys meanwhile: this process stops reading stdin altogether.
		this.suspended = true;
		clearTimeout(this.escTimer);
		this.pending = "";
		this.stdin.off("data", this.onInput);
		this.stdin.pause();
		this.restoreTerminal();

		const pager = splitCommandLine(process.env.PAGER || "less +G");
		if (pager.length === 0) pager.push("less", "+G");
		try {
			this.pager = Bun.spawn([...pager, pagerPath], {
				stdio: ["inherit", "inherit", "inherit"],
			});
			this.releaseInterrupts = holdInterrupts(() => this.pager?.kill());
			await this.pager.exited;
		} catch {
			this.flash(`Could not run ${pager[0]}`);
		} finally {
			this.cleanupPagerTemp();
			this.releaseInterrupts?.();
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
			if (this.taskSet.has(app) || this.notStarted(app)) return [];
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
		if (!this.errorsOnly && !this.searchQuery) return this.lines;
		this.filteredOverviewCache ??= this.lines.filter((line) =>
			this.matchesOverviewFilter(line),
		);
		return this.filteredOverviewCache;
	}

	private sidebarEntries() {
		return this.options.apps.map((name) => {
			const state = this.options.output.states.get(name);
			return {
				name,
				state: this.notStarted(name) ? ("off" as const) : state?.state,
				detail: state?.detail,
				unread: this.unread.has(name),
				kind: this.taskSet.has(name) ? ("task" as const) : ("app" as const),
			};
		});
	}

	private render(): void {
		if (!this.active || this.suspended || !this.dirty) return;

		this.dirty = false;
		this.lastRender = performance.now();

		const { cols, rows } = this.size();
		const side = this.effectiveSidebarWidth();
		const pane = this.renderPaneSize();
		const app = this.selectedApp();
		const { output } = this.options;

		for (const [name, screen] of output.screens) this.hookScreen(name, screen);

		let body: string[];
		if (pane.rows === 0) {
			body = [];
		} else if (side > 0) {
			const sidebar = layoutSidebar(
				this.sidebarEntries(),
				this.selected,
				side,
				pane.rows,
				this.sidebarOffset,
			);
			this.sidebarOffset = sidebar.nextOffset;
			const main = this.renderMain(app, pane);
			body = sidebar.rows.map(
				(left, index) => `${left}${pc.dim("│")}${main[index] ?? ""}`,
			);
		} else {
			body = this.renderMain(app, pane);
		}

		const next =
			rows <= 1
				? [this.header(app, side, cols)]
				: [this.header(app, side, cols), ...body, this.footer(app, cols)];

		// Only the rows that changed since the last frame are written.
		let out = "";
		next.forEach((row, index) => {
			if (this.frame[index] !== row) out += `\u001b[${index + 1};1H${row}`;
		});
		this.frame = next;

		// The app's own cursor, where it is, while keys go to it.
		const screen = app ? output.screens.get(app) : undefined;
		const showAppCursor =
			this.mode.kind === "interact" &&
			screen?.cursorVisible &&
			this.scrollOf(app ?? "") === 0 &&
			pane.rows > 0;
		if (showAppCursor && screen) {
			const buffer = screen.term.buffer.active;
			const paneStartCol = side > 0 ? side + 2 : 1;
			const cursorRow = Math.min(buffer.cursorY + 2, rows - 1);
			const cursorCol = Math.min(paneStartCol + buffer.cursorX, cols);
			out += `\u001b[${cursorRow};${cursorCol}H\u001b[?25h`;
		} else {
			out += "\u001b[?25l";
		}

		this.write(`${SYNC_START}${out}${SYNC_END}`);
	}

	private renderMain(
		app: string | undefined,
		pane: { cols: number; rows: number },
	): string[] {
		const { output } = this.options;

		const overlay = typedSwitch(this.mode, "kind", {
			info: ({ scroll }) =>
				renderInfo(this.infoLines(), pane.cols, pane.rows, scroll),
			picker: ({ index: picked, intent }) => {
				const targets = this.urlTargets();
				const prompt =
					intent === "copy" ? " Copy which app URL?" : " Open which app?";
				const rows = [
					fit(pc.bold(prompt), pane.cols),
					...targets.map(([name, url], index) => {
						const label =
							index === picked
								? pc.inverse(` ${name} `)
								: ` ${colorizeName(name)} `;
						return fit(`${label} ${pc.dim(url)}`, pane.cols);
					}),
				];
				while (rows.length < pane.rows) rows.push(" ".repeat(pane.cols));
				return rows.slice(0, pane.rows);
			},
			navigate: () => undefined,
			interact: () => undefined,
			search: () => undefined,
		});
		if (overlay) return overlay;

		if (!app) {
			const overview = this.overviewLayout(pane);
			return this.highlight(overview.rows, pane.cols, overview.rowMap);
		}

		if (this.notStarted(app)) {
			const rows = [
				fit(` ${colorizeName(app)} is not part of this run yet.`, pane.cols),
				fit(
					pc.dim(` Press ${pc.bold("r")} or ${pc.bold("s")} to start it.`),
					pane.cols,
				),
			];
			while (rows.length < pane.rows) rows.push(" ".repeat(pane.cols));
			return rows.slice(0, pane.rows);
		}

		// No terminal for this app: show the lines it printed.
		const screen = output.screens.get(app);
		if (!screen) {
			const tail = output.tail(app);
			const end = Math.max(0, tail.length - (this.scroll.get(app) ?? 0));
			const visible = tail.slice(Math.max(0, end - pane.rows), end);
			const rows = visible.map((line) => {
				const rendered = fit(line, pane.cols);
				return this.searchQuery
					? highlightMatches(rendered, this.searchQuery, pane.cols)
					: rendered;
			});
			while (rows.length < pane.rows) rows.unshift(" ".repeat(pane.cols));
			return rows;
		}

		const buffer = screen.term.buffer.active;
		const start = Math.max(0, buffer.baseY - this.scrollOf(app));
		const cell = buffer.getNullCell();

		return this.highlight(
			Array.from({ length: pane.rows }, (_, y) => {
				const rendered = renderScreenRow(
					buffer.getLine(start + y),
					pane.cols,
					cell,
				);
				return this.searchQuery
					? highlightMatches(rendered, this.searchQuery, pane.cols)
					: rendered;
			}),
			pane.cols,
		);
	}

	/** The pane's rows with the selection, if it is in this pane, reversed. */
	private highlight(
		rows: string[],
		width: number,
		overviewRowMap?: readonly (OverviewRowMap | undefined)[],
	): string[] {
		if (this.selection?.pane !== (this.selectedApp() ?? "")) return rows;

		const range = this.orderedSelection();
		if (!range) return rows;

		return rows.map((row, y) => {
			if (overviewRowMap) {
				const mapped = overviewRowMap[y];
				const inRange =
					mapped !== undefined &&
					mapped.lineIndex >= range.start.row &&
					mapped.lineIndex <= range.end.row;
				if (!inRange) return row;

				const selStart =
					mapped.lineIndex === range.start.row ? range.start.col : 0;
				const selEnd =
					mapped.lineIndex === range.end.row
						? range.end.col + 1
						: Number.MAX_SAFE_INTEGER;
				if (selEnd <= mapped.plainStart || selStart >= mapped.plainEnd) {
					return row;
				}
				const from =
					mapped.visualIndent + Math.max(0, selStart - mapped.plainStart);
				const spanCap = Math.min(mapped.plainEnd, selEnd) - mapped.plainStart;
				const to = Math.min(width, mapped.visualIndent + spanCap);
				if (to <= from) return row;
				return highlightColumns(row, Math.min(from, width), to, width);
			}

			const content = this.contentRow(y);
			const isSelected =
				content !== undefined &&
				content >= range.start.row &&
				content <= range.end.row;
			if (!isSelected) return row;

			const from = content === range.start.row ? range.start.col : 0;
			const to = content === range.end.row ? range.end.col + 1 : width;
			return highlightColumns(row, from, to, width);
		});
	}

	private header(app: string | undefined, side: number, cols: number): string {
		const scrolledBack = (lines: number) =>
			lines > 0 ? pc.yellow(`  ↑ ${lines} lines · End to follow`) : "";

		const paneTitle = (): string => {
			if (!app) {
				const filter = this.errorsOnly
					? pc.yellow("  errors and warnings only")
					: "";
				const wrap = this.wrapOverview ? pc.dim("  wrap") : "";
				const search = this.searchQuery
					? pc.cyan(
							`  /${this.searchQuery} (${this.overviewLines().length} matches)`,
						)
					: "";
				return ` Overview${filter}${wrap}${search}${scrolledBack(this.scroll.get("") ?? 0)}`;
			}
			const url =
				this.taskSet.has(app) || this.notStarted(app)
					? undefined
					: this.options.urlFor(app);
			const address = url ? `  ${pc.cyan(url)}` : "";
			let search = "";
			if (this.searchQuery) {
				const matchLabel =
					this.searchMatchRows.length === 0
						? "0 matches"
						: `${this.searchMatchCursor + 1}/${this.searchMatchRows.length}`;
				search = pc.cyan(`  /${this.searchQuery} (${matchLabel})`);
			}
			const interacting =
				this.mode.kind === "interact"
					? pc.green("  keys go to the app · Esc to leave")
					: "";
			return ` ${colorizeName(app)}${address}${search}${scrolledBack(this.scrollOf(app))}${interacting}`;
		};

		const title = typedSwitch(this.mode, "kind", {
			info: () =>
				` ${pc.bold("Environment & Keys")}  ${pc.dim("↑↓ scroll · Esc close")}`,
			navigate: paneTitle,
			interact: paneTitle,
			picker: paneTitle,
			search: paneTitle,
		});

		if (side === 0) {
			const badge = pc.inverse(pc.bold(" buncargo "));
			return fit(`${badge}${title}`, cols);
		}

		const profileTag = this.options.profile
			? ` ${pc.dim(this.options.profile)}`
			: "";
		const left = fit(`${pc.inverse(pc.bold(" buncargo "))}${profileTag}`, side);
		return `${left}${pc.dim("│")}${fit(title, Math.max(0, cols - side - 1))}`;
	}

	private footer(app: string | undefined, cols: number): string {
		const modeFooter = typedSwitch(this.mode, "kind", {
			search: () => {
				const status = app
					? `${this.searchMatchRows.length} matches`
					: `${this.overviewLines().length} matches`;
				const hint = pc.dim(`${status} · Enter apply · Esc cancel`);
				return fit(
					` ${pc.cyan("/")}${this.searchQuery}${pc.inverse(" ")}  ${hint}`,
					cols,
				);
			},
			info: () =>
				fit(
					` ${pc.bold("↑↓ / Ctrl-U D")} scroll · ${pc.bold("i / Esc")} close`,
					cols,
				),
			picker: ({ intent }) => {
				const verb = intent === "copy" ? "copy" : "open";
				return fit(
					` ${pc.bold("↑↓")} choose · ${pc.bold("Enter")} ${verb} · ${pc.bold("Esc")} cancel`,
					cols,
				);
			},
			interact: () =>
				this.message
					? fit(` ${this.message}`, cols)
					: fit(
							` ${pc.green("●")} interacting with ${app} · ${pc.bold("Esc")} back to buncargo`,
							cols,
						),
			navigate: () =>
				this.message ? fit(` ${this.message}`, cols) : undefined,
		});
		if (modeFooter !== undefined) return modeFooter;

		return renderFooter(
			this.hints(app).map((hint) => {
				const space = hint.indexOf(" ");
				if (space < 0) return pc.bold(hint);
				return `${pc.bold(hint.slice(0, space))} ${hint.slice(space + 1)}`;
			}),
			this.liveActions(),
			cols,
		);
	}

	/** The footer's keys for the selected app, or the Overview's. */
	private hints(app: string | undefined): string[] {
		if (!app) {
			return [
				"↑↓ select",
				"/ find",
				"e errors",
				"o open",
				"y copy",
				"l logs",
				"i info",
				"q quit",
			];
		}
		if (this.notStarted(app)) {
			return ["↑↓ select", "r start", "i info", "esc overview", "q quit"];
		}

		const isTask = this.taskSet.has(app);
		const state = this.options.output.states.get(app);
		const isStopped = isTask
			? state?.detail !== "running"
			: state?.state === "stopped" || state?.state === "failed";
		const stopHint = isTask
			? isStopped
				? []
				: ["s stop"]
			: [isStopped ? "s start" : "s stop"];

		return [
			"↑↓ select",
			...(isTask ? [] : ["enter interact"]),
			...(!isTask && this.options.urlFor(app) ? ["o open"] : []),
			isTask ? "r run" : "r restart",
			...stopHint,
			"/ find",
			...(this.searchQuery ? ["n/N match"] : []),
			"l log",
			"i info",
			"q quit",
		];
	}
}
