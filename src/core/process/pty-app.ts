import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync } from "node:fs";
import { recordStartupMetric } from "../startup-metrics";

/**
 * On macOS the child runs nothing until `Bun.spawn` has returned. Bun up to
 * 1.4.3 hangs for good when a terminal child prints and starts exiting first
 * (oven-sh/bun#45300): `Bun.spawn` blocks in `wait4` for it, and XNU lets a
 * terminal's session leader finish exiting only once its output is read,
 * which the blocked thread would have done. Nothing else runs meanwhile, not
 * even a timer, so an app that failed at once could freeze the whole run.
 * Linux is spared: an exit there does not wait for terminal output. The gate
 * reads fd 3 until we close our end, then `exec`s the command, keeping its
 * pid, session and exit. Drop this once `engines.bun` is a release with the
 * fix.
 */
const GATED = process.platform === "darwin";
const GATE = 'read -r _ <&3; exec 3<&- "$@"';

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
		const command = GATED ? ["/bin/sh", "-c", GATE, "sh", ...argv] : argv;
		this.proc = Bun.spawn(command, {
			cwd: options.cwd,
			env: { ...options.env, TERM: "xterm-256color" },
			terminal: {
				cols: options.cols,
				rows: options.rows,
				data: (_terminal, data) => options.onData(data),
			},
			// The terminal takes fds 0-2; the gate waits on 3.
			stdio: GATED ? ["ignore", "ignore", "ignore", "pipe"] : undefined,
		});

		// Spawned and watched: open the gate, or fail the start rather than
		// leave the app waiting forever.
		if (GATED) {
			const gate = this.proc.stdio[3];
			if (typeof gate !== "number") {
				this.proc.kill("SIGKILL");
				const message = `Bun ${Bun.version} gave no fd 3 to "${argv.join(" ")}", which waits on it to start under a terminal`;
				throw new Error(message);
			}
			closeSync(gate);
		}

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
