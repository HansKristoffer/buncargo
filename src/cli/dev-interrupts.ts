import { typedSwitch } from "hanzio";
import { RunInterrupted } from "../core/process/app-lifecycle";

/**
 * How a `dev` run takes SIGINT, SIGTERM and SIGHUP.
 *
 * The first one interrupts: the run's signal aborts with `RunInterrupted`
 * (the reason the supervisor reads as "stop the apps, this is no failure"),
 * the run tears down, and it exits 128 + the signal's number whichever way it
 * got there.
 *
 * While the apps are still stopping, a second one only says which: an app
 * can take its `stopGraceMs` to save data (the Firebase emulators export for
 * up to a minute), and exiting closes the pseudo-terminal a TUI or
 * terminal-less app runs in, which ends it mid-save. A third one exits.
 * Once the apps are down, a second one exits at once: a teardown step that
 * hangs used to leave SIGKILL as the only way out. The sweep reads a run that
 * died without releasing as a crash, and its containers wait out the idle
 * hold. `ci` does the opposite on purpose: its teardown removes a volume and
 * must finish.
 */

export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
export type RunSignal = keyof typeof SIGNAL_EXIT;

/**
 * The same signal this soon after the one before is that one again, not
 * another Ctrl-C: `bun run dev` forwards the terminal's Ctrl-C to a child the
 * terminal already sent it to, and a prompt raises the SIGINT it read.
 */
export const SIGNAL_ECHO_MS = 100;

export type InterruptState =
	| { kind: "running" }
	| {
			kind: "interrupted";
			/** The first signal, whose exit code the run ends with. */
			signal: RunSignal;
			/** The last signal taken, and when, for the echo filter. */
			last: RunSignal;
			at: number;
			/** Whether a signal has already been answered with the apps still stopping. */
			warned: boolean;
	  };

export type SignalDecision =
	| { action: "interrupt"; next: InterruptState }
	| { action: "ignore" }
	| { action: "warn"; apps: readonly string[]; next: InterruptState }
	| { action: "force-exit"; code: number };

/**
 * What a signal arriving at `now` does to a run in `state`, with `stopping`
 * the apps whose processes have not exited yet.
 */
export function decideSignal(
	state: InterruptState,
	signal: RunSignal,
	now: number,
	stopping: readonly string[],
): SignalDecision {
	return typedSwitch(state, "kind", {
		running: (): SignalDecision => ({
			action: "interrupt",
			next: {
				kind: "interrupted",
				signal,
				last: signal,
				at: now,
				warned: false,
			},
		}),
		interrupted: (previous): SignalDecision => {
			const echo =
				signal === previous.last && now - previous.at < SIGNAL_ECHO_MS;
			if (echo) return { action: "ignore" };
			const firstWhileStopping = !previous.warned && stopping.length > 0;
			if (firstWhileStopping)
				return {
					action: "warn",
					apps: stopping,
					next: { ...previous, last: signal, at: now, warned: true },
				};
			return { action: "force-exit", code: SIGNAL_EXIT[previous.signal] };
		},
	});
}

export interface RunInterrupts {
	/** Aborts with `RunInterrupted` on the first signal. */
	readonly signal: AbortSignal;
	/** 128 + the signal once interrupted, else `undefined`. */
	exitCode(): number | undefined;
	/** A prompt read Ctrl-C or Ctrl-D: the run is interrupted by SIGINT. */
	promptInterrupted(): void;
	dispose(): void;
}

/**
 * Listen for the run's signals until `dispose()`. `stopping` names the apps
 * whose processes are still running; `warn` is called with them on a second
 * signal while there are any, and `forceExit` on the signal after that (or a
 * second one once there are none), with the first one's exit code. It must
 * not return.
 */
export function listenForInterrupts(options: {
	clock: () => number;
	stopping: () => readonly string[];
	warn: (apps: readonly string[]) => void;
	forceExit: (code: number) => never;
}): RunInterrupts {
	const controller = new AbortController();
	let state: InterruptState = { kind: "running" };
	const receive = (signal: RunSignal) => {
		const decision = decideSignal(
			state,
			signal,
			options.clock(),
			options.stopping(),
		);
		typedSwitch(decision, "action", {
			interrupt: ({ next }) => {
				state = next;
				controller.abort(new RunInterrupted(`Run interrupted (${signal})`));
			},
			ignore: () => {},
			warn: ({ apps, next }) => {
				state = next;
				options.warn(apps);
			},
			"force-exit": ({ code }) => options.forceExit(code),
		});
	};
	const listeners = (Object.keys(SIGNAL_EXIT) as RunSignal[]).map((signal) => {
		const listener = () => receive(signal);
		process.on(signal, listener);
		return { signal, listener };
	});

	return {
		signal: controller.signal,
		exitCode: () =>
			state.kind === "interrupted" ? SIGNAL_EXIT[state.signal] : undefined,
		promptInterrupted: () => {
			if (state.kind === "running") receive("SIGINT");
		},
		dispose: () => {
			for (const { signal, listener } of listeners)
				process.off(signal, listener);
		},
	};
}
