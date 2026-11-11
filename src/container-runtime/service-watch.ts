import { timeoutSignal, typedSwitch, typedSwitchGroup } from "hanzio";
import { projectServiceStates } from "./containers";
import type { ContainerRuntimeAdapter, ServiceRuntimeState } from "./types";

/**
 * Watching a live run's service containers, so one that stops under it is
 * said out loud instead of surfacing minutes later as an app's refused
 * connection while `status` reports every app ready.
 *
 * Polled through the runtime's one container listing.
 * ponytail: one `docker ps` per run every interval; `docker events` would
 * cost nothing between changes, but Apple `container` has no event stream.
 */

export type ServiceCondition =
	| { state: "up" }
	| { state: "unhealthy" }
	/**
	 * Serving nothing. `why` says when the container is still there: between
	 * restarts under its restart policy, or paused.
	 */
	| { state: "stopped"; exitCode?: number; why?: "restarting" | "paused" }
	| { state: "missing" };

export interface ServiceChange {
	/** Compose service name. */
	service: string;
	condition: ServiceCondition;
}

function conditionOf(state: ServiceRuntimeState): ServiceCondition | undefined {
	const exit = state.exitCode === undefined ? {} : { exitCode: state.exitCode };
	return typedSwitch(state.state, {
		running: (): ServiceCondition => ({
			state: state.healthy === false ? "unhealthy" : "up",
		}),
		restarting: (): ServiceCondition => ({
			state: "stopped",
			...exit,
			why: "restarting",
		}),
		paused: (): ServiceCondition => ({ state: "stopped", why: "paused" }),
		...typedSwitchGroup(
			state.state,
			["created", "stopping", "stopped"],
			(): ServiceCondition => ({ state: "stopped", ...exit }),
		),
		// Nothing to say about a state we cannot read; the last word stands.
		unknown: () => undefined,
	});
}

/**
 * What each watched service is doing, from a listing the runtime answered.
 * An empty one means every watched container is gone. A service whose state
 * the runtime did not say is left out, so what was last reported stands.
 */
export function observeServices(
	watched: readonly string[],
	states: readonly ServiceRuntimeState[],
): Map<string, ServiceCondition> {
	// A running container of a service wins over a stale stopped one.
	const byService = new Map<string, ServiceRuntimeState>();
	for (const state of states)
		if (!byService.get(state.service)?.serving)
			byService.set(state.service, state);
	const observed = new Map<string, ServiceCondition>();
	for (const service of watched) {
		const state = byService.get(service);
		const condition = state
			? conditionOf(state)
			: { state: "missing" as const };
		if (condition) observed.set(service, condition);
	}
	return observed;
}

const isRestarting = (condition: ServiceCondition | undefined) =>
	condition?.state === "stopped" && condition.why === "restarting";

/**
 * What to report next, from what was reported and the last two observations.
 * A crash-looping container is up between restarts, and a poll that lands
 * there must not announce it running again: after a restart, "up" counts
 * once two polls in a row see it.
 */
export function settleConditions(
	reported: ReadonlyMap<string, ServiceCondition>,
	previouslyObserved: ReadonlyMap<string, ServiceCondition>,
	observed: ReadonlyMap<string, ServiceCondition>,
): Map<string, ServiceCondition> {
	const settled = new Map(reported);
	for (const [service, condition] of observed) {
		const unconfirmed =
			condition.state === "up" &&
			isRestarting(reported.get(service)) &&
			previouslyObserved.get(service)?.state !== "up";
		if (!unconfirmed) settled.set(service, condition);
	}
	return settled;
}

/** The services whose condition changed; a service seen for the first time counts as up before. */
export function serviceChanges(
	previous: ReadonlyMap<string, ServiceCondition>,
	next: ReadonlyMap<string, ServiceCondition>,
): ServiceChange[] {
	const changes: ServiceChange[] = [];
	for (const [service, condition] of next) {
		const before = previous.get(service) ?? { state: "up" };
		if (JSON.stringify(before) !== JSON.stringify(condition))
			changes.push({ service, condition });
	}
	return changes;
}

/** "postgres stopped (exit 0)", "redis is unhealthy", "postgres is running again". */
export function describeServiceCondition(change: ServiceChange): string {
	const { service, condition } = change;
	return typedSwitch(condition, "state", {
		up: () => `${service} is running again`,
		unhealthy: () => `${service} is unhealthy: its healthcheck fails`,
		stopped: ({ exitCode, why }) => {
			const exit = exitCode === undefined ? "" : ` (exit ${exitCode})`;
			if (why === "restarting") return `${service} keeps restarting${exit}`;
			if (why === "paused") return `${service} is paused`;
			return `${service} stopped${exit}`;
		},
		missing: () => `${service}'s container was removed`,
	});
}

/** Long enough that a run does not notice the poll; short next to "minutes later, a Prisma error". */
export const SERVICE_WATCH_INTERVAL_MS = 10_000;

/**
 * Poll the services until the returned function is called. Never keeps the
 * process alive, and never overlaps polls: a hung daemon costs one stuck
 * listing, cut off by its timeout, not a pile of them.
 */
export function watchServiceContainers(input: {
	runtime: Pick<ContainerRuntimeAdapter, "containers">;
	projectName: string;
	/** Compose service names, read on every poll so services can join later. */
	services: () => readonly string[];
	onChange: (changes: ServiceChange[]) => void;
	intervalMs?: number;
}): () => void {
	const controller = new AbortController();
	const intervalMs = input.intervalMs ?? SERVICE_WATCH_INTERVAL_MS;
	let known = new Map<string, ServiceCondition>();
	let lastObserved = new Map<string, ServiceCondition>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const poll = async () => {
		const watched = input.services();
		if (watched.length > 0) {
			const signal = timeoutSignal(intervalMs, controller.signal);
			let states: ServiceRuntimeState[] | undefined;
			try {
				states = await projectServiceStates(
					input.runtime,
					input.projectName,
					signal,
				);
			} catch {
				// Unanswered: nothing is known to have changed.
			}
			if (controller.signal.aborted) return;
			if (states) {
				const observed = observeServices(watched, states);
				const next = settleConditions(known, lastObserved, observed);
				const changes = serviceChanges(known, next);
				known = next;
				lastObserved = observed;
				try {
					if (changes.length > 0) input.onChange(changes);
				} catch {
					// A failed report must not end the watch.
				}
			}
		}
		schedule();
	};
	const schedule = () => {
		if (controller.signal.aborted) return;
		timer = setTimeout(() => void poll(), intervalMs);
		timer.unref?.();
	};

	schedule();
	return () => {
		controller.abort();
		clearTimeout(timer);
	};
}
