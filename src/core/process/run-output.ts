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
const WARN = /\bwarn(ing)?s?\b|⚠/i;

export function lineLevel(text: string): OutputLine["level"] {
	if (ERROR.test(text)) return "error";
	if (WARN.test(text)) return "warn";
	return undefined;
}

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
			screen = new AppScreen(cols, rows, (text) => this.line(app, text));
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

	close(): void {
		for (const screen of this.screens.values()) void screen.flush();
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
	const errors = tail.filter((line) => lineLevel(line) === "error");
	return (errors.length > 0 ? errors : tail).slice(-max);
}
