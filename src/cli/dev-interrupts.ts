import { typedSwitch } from "hanzio";
import { RunInterrupted } from "../core/process/process-owner";

/**
 * How a `dev` run takes SIGINT, SIGTERM and SIGHUP.
 *
 * The first one interrupts: the run's signal aborts with `RunInterrupted`
 * (the reason the supervisor reads as "stop the apps, this is no failure"),
 * the run tears down, and it exits 128 + the signal's number whichever way it
 * got there. A second one exits at once: a teardown step that hangs used to
 * leave SIGKILL as the only way out. The sweep reads a run that died without
 * releasing as a crash, and its containers wait out the idle hold, so nothing
 * of the developer's is lost by leaving early. `ci` does the opposite on
 * purpose: its teardown removes a volume and must finish.
 */

export const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
export type RunSignal = keyof typeof SIGNAL_EXIT;

/**
 * The same signal this soon after the first is the first one again, not a
 * second Ctrl-C: `bun run dev` forwards the terminal's Ctrl-C to a child the
 * terminal already sent it to, and a prompt raises the SIGINT it read.
 */
export const SIGNAL_ECHO_MS = 100;

export type InterruptState =
	{ kind: "running" } | { kind: "interrupted"; signal: RunSignal; at: number };

export type SignalDecision =
	| { action: "interrupt"; next: InterruptState }
	| { action: "ignore" }
	| { action: "force-exit"; code: number };

/** What a signal arriving at `now` does to a run in `state`. */
export function decideSignal(
	state: InterruptState,
	signal: RunSignal,
	now: number,
): SignalDecision {
	return typedSwitch(state, "kind", {
		running: (): SignalDecision => ({
			action: "interrupt",
			next: { kind: "interrupted", signal, at: now },
		}),
		interrupted: (first): SignalDecision => {
			const echo = signal === first.signal && now - first.at < SIGNAL_ECHO_MS;
			return echo
				? { action: "ignore" }
				: { action: "force-exit", code: SIGNAL_EXIT[first.signal] };
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
 * Listen for the run's signals until `dispose()`. `forceExit` is called on a
 * second signal, with the first one's exit code, and must not return.
 */
export function listenForInterrupts(options: {
	clock: () => number;
	forceExit: (code: number) => never;
}): RunInterrupts {
	const controller = new AbortController();
	let state: InterruptState = { kind: "running" };
	const receive = (signal: RunSignal) => {
		const decision = decideSignal(state, signal, options.clock());
		typedSwitch(decision, "action", {
			interrupt: ({ next }) => {
				state = next;
				controller.abort(new RunInterrupted(`Run interrupted (${signal})`));
			},
			ignore: () => {},
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
