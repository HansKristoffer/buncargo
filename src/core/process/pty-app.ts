import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { recordStartupMetric } from "../startup-metrics";

/**
 * An app running under its own pseudo-terminal (`Bun.spawn({ terminal })`).
 *
 * It looks to the supervisor like a `ChildProcess`: a pid that leads its own
 * process group (the pty makes it a session leader, so `kill(-pid)` reaches
 * everything it spawned), `exitCode`/`signalCode`, and an `exit` event with
 * Node's arguments — a signalled exit reports `(null, signal)`, not Bun's
 * `128 + n`.
 */
export class PtyApp extends EventEmitter {
	readonly pid: number;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	private readonly proc: Bun.Subprocess;

	constructor(
		argv: string[],
		options: {
			cwd: string;
			env: Record<string, string | undefined>;
			cols: number;
			rows: number;
			onData(data: Uint8Array): void;
		},
	) {
		super();
		recordStartupMetric("subprocesses");
		this.proc = Bun.spawn(argv, {
			cwd: options.cwd,
			env: { ...options.env, TERM: "xterm-256color" },
			terminal: {
				cols: options.cols,
				rows: options.rows,
				data: (_terminal, data) => options.onData(data),
			},
		});
		this.pid = this.proc.pid;
		// Node's `spawn` event: Bun spawns synchronously, so it is already true.
		queueMicrotask(() => this.emit("spawn"));
		void this.proc.exited.then(() => {
			const signal = this.proc.signalCode as NodeJS.Signals | null;
			this.signalCode = signal;
			this.exitCode = signal ? null : this.proc.exitCode;
			this.proc.terminal?.close();
			this.emit("exit", this.exitCode, this.signalCode);
		});
	}

	write(data: string): void {
		if (this.exitCode === null && this.signalCode === null)
			this.proc.terminal?.write(data);
	}

	resize(cols: number, rows: number): void {
		if (this.exitCode === null && this.signalCode === null)
			this.proc.terminal?.resize(cols, rows);
	}

	unref(): void {
		this.proc.unref();
		this.proc.terminal?.unref();
	}
}

/** What the supervisor owns: a piped child or one under a pseudo-terminal. */
export type AppChild = ChildProcess | PtyApp;
