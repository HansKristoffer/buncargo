import pc from "picocolors";
import {
	colorizeName,
	formatPrefixedLine,
	formatSection,
	isBlankLogLine,
} from "../style";
import type { AppLogs } from "./app-logs";
import { AppScreen } from "./app-screen";
import { type CapturedValue, stripTerminalOutput } from "./output-capture";

/**
 * Where a run's app output goes: one text feed per app that drives the
 * stream printer, the TUI's Overview and the log files alike, so the three
 * cannot disagree. Apps print into it (`line`), the supervisor reports what
 * happened to them (`state`, `capture`), and views subscribe.
 */

export type AppState = "starting" | "ready" | "stopped" | "failed";

export interface OutputLine {
	app: string;
	/** As the app printed it, colours included. */
	raw: string;
	/** What a person reads: no escapes. Goes to the log file and the Overview. */
	text: string;
	time: Date;
	/** A run event about the app ("ready", "stopped (exit 1)"), not its output. */
	event: boolean;
	/** Already on the user's terminal (a stream-mode attached app): log it, do not print it. */
	echoed?: boolean;
	level?: "error" | "warn";
}

export interface AppStateDetail {
	state: AppState;
	/** "exit 1", "signal SIGTERM". */
	detail?: string;
	/** Not essential: the run went on, and `r` / `buncargo restart` brings it back. */
	restartable?: boolean;
}

export interface RunOutputListener {
	line?(line: OutputLine): void;
	state?(app: string, state: AppStateDetail): void;
	capture?(app: string, captured: CapturedValue): void;
}

const TAIL_LINES = 50;

const ERROR =
	/\b(error|errors|failed|failure|exception|fatal|panic)\b|✗|✖|ERR!/i;
/** `TypeError: …`, `PrismaClientKnownRequestError`: one word, so not caught above. */
const NAMED_ERROR = /\b[A-Z]\w*(?:Error|Exception)\b/;
const WARN = /\bwarn(ing)?s?\b|⚠/i;

/** Level words a logger writes, by what `logs --errors` makes of them. */
const LEVEL_WORDS: Record<string, OutputLine["level"] | "info"> = {
	trace: "info",
	debug: "info",
	info: "info",
	notice: "info",
	warn: "warn",
	warning: "warn",
	error: "error",
	err: "error",
	fatal: "error",
	crit: "error",
	critical: "error",
	panic: "error",
};

/** Pino's numeric levels: 40 is warn, 50 error, 60 fatal. */
function numericLevel(value: number): OutputLine["level"] | "info" {
	if (value >= 50) return "error";
	if (value >= 40) return "warn";
	return "info";
}

/** `level=info`, `"level":"warn"`, `"level":30`: logfmt and JSON loggers. */
const KEYED_LEVEL = /\blevel["']?\s*[=:]\s*["']?([a-z]+|\d{2})\b/i;

/** How many leading words may come before the level: a timestamp, a `[scope]`, a pid. */
const LEVEL_SEARCH_WORDS = 4;
/** The head of a line the level is looked for in: every output line passes here. */
const LEVEL_SEARCH_CHARS = 120;

/**
 * The level a logger wrote at the head of the line (`INFO:`, `[WARN]`,
 * `[core] INFO:`, `2026-… ERROR …`) or as a key (`level=info`), or undefined
 * when it wrote none. A word counts when it is bracketed, ends in a colon or
 * is in capitals, so prose that starts with "info" is not a level.
 */
function explicitLevel(text: string): OutputLine["level"] | "info" | undefined {
	const keyed = KEYED_LEVEL.exec(text)?.[1];
	if (keyed !== undefined) {
		const asNumber = Number(keyed);
		if (!Number.isNaN(asNumber)) return numericLevel(asNumber);
		const level = LEVEL_WORDS[keyed.toLowerCase()];
		if (level !== undefined) return level;
	}
	const head = text.trimStart().slice(0, LEVEL_SEARCH_CHARS);
	const words = head.split(/\s+/, LEVEL_SEARCH_WORDS);
	for (const word of words) {
		const bare = word.replace(/^[[(<]+|[\])>:,]+$/g, "");
		const marked = bare !== word || /^[A-Z]+$/.test(bare);
		const level = LEVEL_WORDS[bare.toLowerCase()];
		if (marked && level !== undefined) return level;
	}
	return undefined;
}

/**
 * How a line reads: the level its logger wrote when there is one, so
 * `[core] INFO: Failed to read crontab` is not an error; otherwise by its
 * words.
 */
export function lineLevel(text: string): OutputLine["level"] {
	const explicit = explicitLevel(text);
	if (explicit !== undefined) return explicit === "info" ? undefined : explicit;
	if (ERROR.test(text) || NAMED_ERROR.test(text)) return "error";
	if (WARN.test(text)) return "warn";
	return undefined;
}

/** Past this, an unclosed `{` is not a block any more: the filter starts over. */
const MAX_BLOCK_LINES = 200;

function bracketBalance(text: string): number {
	let balance = 0;
	for (const char of text) {
		if (char === "{" || char === "[") balance++;
		else if (char === "}" || char === "]") balance--;
	}
	return balance;
}

/**
 * A filter for one app's lines, in order, that keeps its errors. A line that
 * opens a structured block (`[ERROR] job.completed {`) keeps the block with
 * it, and the block's lines take the level of the line that opened it:
 * `error_type: "Error",` alone is a fragment, and inside an INFO block it is
 * no error at all.
 */
export function createErrorFilter(): (text: string) => boolean {
	let depth = 0;
	let blockLines = 0;
	let keepBlock = false;
	return (text) => {
		if (depth > 0 && blockLines < MAX_BLOCK_LINES) {
			depth += bracketBalance(text);
			blockLines++;
			return keepBlock;
		}
		depth = 0;
		const keep = lineLevel(text) === "error";
		const opensBlock = /[{[]$/.test(text.trimEnd());
		if (opensBlock) {
			depth = Math.max(bracketBalance(text), 1);
			blockLines = 0;
			keepBlock = keep;
		}
		return keep;
	};
}

const SCREEN_DROPPED =
	"Output dropped: the app printed faster than its screen could parse, so lines of this burst are missing here and in its log.";

export class RunOutput {
	/** Set when every app runs under its own pseudo-terminal of this size (the TUI). */
	terminalSize?: () => { cols: number; rows: number };
	/** Bound by the spawner: what a view may ask of the run. */
	controls?: { restart(name: string): Promise<void> };
	readonly screens = new Map<string, AppScreen>();
	readonly states = new Map<string, AppStateDetail>();
	/** Captured values per app, by capture name. */
	readonly captured = new Map<string, Map<string, string>>();
	private listeners = new Set<RunOutputListener>();
	private tails = new Map<string, string[]>();

	constructor(readonly logs?: AppLogs) {}

	subscribe(listener: RunOutputListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** One complete line of an app's output. */
	line(app: string, raw: string, options: { echoed?: boolean } = {}): void {
		if (isBlankLogLine(raw)) return;
		const text = stripTerminalOutput(raw).replace(/\n/g, " ").trimEnd();
		if (!text.trim()) return;
		this.emit({
			app,
			raw,
			text,
			time: new Date(),
			event: false,
			echoed: options.echoed,
			level: lineLevel(text),
		});
	}

	/** A line buncargo says about an app. */
	event(app: string, text: string, level?: OutputLine["level"]): void {
		this.emit({ app, raw: text, text, time: new Date(), event: true, level });
	}

	state(app: string, state: AppStateDetail): void {
		this.states.set(app, state);
		if (state.state !== "starting")
			this.event(
				app,
				state.detail ? `${state.state} (${state.detail})` : state.state,
				state.state === "failed" ? "error" : undefined,
			);
		for (const listener of this.listeners) listener.state?.(app, state);
	}

	capture(app: string, captured: CapturedValue): void {
		if (captured.as !== "event") {
			const values = this.captured.get(app) ?? new Map<string, string>();
			values.set(captured.name, captured.value);
			this.captured.set(app, values);
			this.event(app, `${captured.name}: ${captured.value}`);
		}
		for (const listener of this.listeners) listener.capture?.(app, captured);
	}

	/** The last lines an app printed, plain. */
	tail(app: string): readonly string[] {
		return this.tails.get(app) ?? [];
	}

	/** The virtual screen of an app run under a pseudo-terminal. */
	screen(app: string): AppScreen {
		let screen = this.screens.get(app);
		if (!screen) {
			const { cols, rows } = this.terminalSize?.() ?? { cols: 80, rows: 24 };
			screen = new AppScreen(
				cols,
				rows,
				(text) => this.line(app, text),
				() => this.event(app, SCREEN_DROPPED, "warn"),
			);
			this.screens.set(app, screen);
		}
		return screen;
	}

	/** Split a piped stream into lines. */
	pipe(
		app: string,
		stream: NodeJS.ReadableStream | null,
		onText?: (text: string) => void,
		options: { echoed?: boolean } = {},
	): void {
		if (!stream) return;
		let buffer = "";
		stream.on("data", (chunk: Buffer | string) => {
			onText?.(String(chunk));
			buffer += String(chunk);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) this.line(app, line, options);
		});
		stream.on("end", () => {
			if (buffer) this.line(app, buffer, options);
			buffer = "";
		});
	}

	/**
	 * Emit what every app left on screen, then write the log files. Awaited
	 * before a view unsubscribes, or an app's last words reach neither.
	 */
	async close(): Promise<void> {
		await Promise.all(
			[...this.screens.values()].map((screen) => screen.flush()),
		);
		this.logs?.flush();
	}

	private emit(line: OutputLine): void {
		if (!line.event) {
			const tail = this.tails.get(line.app) ?? [];
			tail.push(line.text);
			if (tail.length > TAIL_LINES) tail.shift();
			this.tails.set(line.app, tail);
		}
		this.logs?.write(
			line.app,
			line.event ? `[buncargo] ${line.text}` : line.text,
			line.time,
		);
		for (const listener of this.listeners) listener.line?.(line);
	}
}

/**
 * Stream mode: each app's lines, prefixed with its name, on stdout. What every
 * run printed before the TUI, and what CI, agents and piped output still get.
 */
export function printStream(
	output: RunOutput,
	options: { width: number; write?: (text: string) => void },
): () => void {
	const write = options.write ?? ((text) => process.stdout.write(text));
	let headerPrinted = false;
	return output.subscribe({
		line(line) {
			if (line.event || line.echoed) return;
			if (!headerPrinted) {
				headerPrinted = true;
				write(`\n${formatSection("Logs")}\n`);
			}
			write(formatPrefixedLine(line.app, line.raw, options.width));
		},
		state(app, { state, detail, restartable }) {
			if (state !== "stopped" && state !== "failed") return;
			if (!restartable) return;
			const lines = [
				`  ${pc.red("✗")}  ${colorizeName(app)} ${state}${detail ? ` (${detail})` : ""}; the rest of the run keeps going`,
				...lastErrorLines(output.tail(app)).map(
					(line) => `       ${pc.dim(line)}`,
				),
				`       ${pc.dim("Restart it:")} buncargo restart ${app}`,
			];
			write(`${lines.join("\n")}\n`);
		},
	});
}

/** The lines worth showing for a stopped app: its errors, else its last words. */
export function lastErrorLines(tail: readonly string[], max = 8): string[] {
	const errors = tail.filter(createErrorFilter());
	return (errors.length > 0 ? errors : tail).slice(-max);
}
