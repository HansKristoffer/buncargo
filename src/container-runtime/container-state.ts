import { typedSwitch, typedSwitchGroup } from "hanzio";

/**
 * What a container is doing, in buncargo's words: the one reading of both
 * runtimes' state strings. Every question about a container's state (is it
 * up, does it hold its ports, has it died while starting) is answered from
 * this, so prune, the sweep, the port allocator, readiness and the service
 * watch cannot disagree about a paused or restarting container.
 *
 * - Docker says `created`, `running`, `paused`, `restarting`, `removing`,
 *   `exited` and `dead`.
 * - Apple says `running`, `stopping`, `stopped` and `unknown`, and its JSON has
 *   moved between releases, so a state it no longer reports where we look is
 *   `unknown` too.
 */
export type ContainerState =
	| "running"
	/** Frozen: holds its ports and memory, serves nothing. Docker only. */
	| "paused"
	/** Between two runs under a restart policy: it exited, and comes back. Docker only. */
	| "restarting"
	/** Created and never started. */
	| "created"
	/** On its way out: Apple's `stopping`, Docker's `removing`. */
	| "stopping"
	| "stopped"
	/** A word neither runtime has shown us, or a field we could not find. */
	| "unknown";

/** The runtimes' words, lower-cased. */
const STATES: Record<string, ContainerState> = {
	running: "running",
	paused: "paused",
	restarting: "restarting",
	created: "created",
	stopping: "stopping",
	removing: "stopping",
	exited: "stopped",
	dead: "stopped",
	stopped: "stopped",
	error: "stopped",
	failed: "stopped",
};

export function parseContainerState(word: string): ContainerState {
	return STATES[word.trim().toLowerCase()] ?? "unknown";
}

/**
 * Running and answering: what reuse, readiness and the watch's "up" require.
 * Paused and restarting containers serve nothing.
 */
export function isContainerServing(state: ContainerState): boolean {
	return state === "running";
}

/**
 * Holds what a running container holds: its published ports, its place in a
 * stack, a reason not to remove it. Prune leaves it, the sweep and `ls` count
 * it as up, the allocator treats its ports as taken. `unknown` counts, since
 * reading a live container as stopped is the costly mistake: it frees its
 * ports to another checkout and makes its stack look abandoned.
 */
export function isContainerLive(state: ContainerState): boolean {
	return typedSwitch(state, {
		...typedSwitchGroup(
			state,
			["running", "paused", "restarting", "stopping", "unknown"],
			() => true,
		),
		...typedSwitchGroup(state, ["created", "stopped"], () => false),
	});
}

/**
 * Known to have stopped. Only this may skip a graceful stop before a forced
 * delete: an `unknown` container may be a database that is running.
 */
export function isContainerStopped(state: ContainerState): boolean {
	return state === "created" || state === "stopped";
}

/** How a container looked when readiness asked why it was not ready yet. */
export interface ContainerObservation {
	/** The runtime's own word. */
	state: string;
	exitCode?: number;
}

/**
 * How many diagnoses in a row may find a service between restarts before
 * readiness calls it a crash loop. One is a restart policy doing its job (a
 * service that lost a race with its dependency); two, seconds apart and with
 * no run between them, is a container that keeps dying.
 */
export const CRASH_LOOP_RESTARTS = 2;

export type StartupVerdict =
	| { kind: "pending" }
	/** It stopped, or is on its way out. */
	| { kind: "stopped" }
	/** It keeps exiting under a restart policy, and will until the timeout. */
	| { kind: "crash-loop" };

/**
 * Whether a starting service has failed, from what readiness has seen of it.
 * `restartsInARow` counts the observations up to this one, included, that
 * found it restarting with no other state between them. Matched positively: a state nobody has shown us keeps
 * polling rather than aborting a startup that would have worked.
 */
export function startupVerdict(
	observation: ContainerObservation,
	restartsInARow: number,
): StartupVerdict {
	const state = parseContainerState(observation.state);
	if (state === "stopped" || state === "stopping") return { kind: "stopped" };
	if (state === "restarting" && restartsInARow >= CRASH_LOOP_RESTARTS)
		return { kind: "crash-loop" };
	return { kind: "pending" };
}
