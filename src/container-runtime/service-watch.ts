import { timeoutSignal, typedSwitch } from "hanzio";
import type { ContainerRuntimeAdapter, ServiceRuntimeState } from "./types";

/**
 * Watching a live run's service containers, so one that stops under it is
 * said out loud instead of surfacing minutes later as an app's refused
 * connection while `status` reports every app ready.
 *
 * Polled through `projectServiceStates`, which both backends implement.
 * ponytail: one `docker ps` per run every interval; `docker events` would
 * cost nothing between changes, but Apple `container` has no event stream.
 */

export type ServiceCondition =
	| { state: "up" }
	| { state: "unhealthy" }
	| { state: "stopped"; exitCode?: number }
	| { state: "missing" };

export interface ServiceChange {
	/** Compose service name. */
	service: string;
	condition: ServiceCondition;
}

/**
 * What each watched service is doing, or undefined when the runtime listed
 * nothing: both backends answer an unreachable daemon with an empty list, so
 * an empty listing cannot tell "all removed" from "cannot ask".
 */
export function observeServices(
	watched: readonly string[],
	states: readonly ServiceRuntimeState[],
): Map<string, ServiceCondition> | undefined {
	if (states.length === 0) return undefined;
	// A running container of a service wins over a stale stopped one.
	const byService = new Map<string, ServiceRuntimeState>();
	for (const state of states)
		if (!byService.get(state.service)?.running)
			byService.set(state.service, state);
	return new Map(
		watched.map((service): [string, ServiceCondition] => {
			const state = byService.get(service);
			if (!state) return [service, { state: "missing" }];
			if (!state.running)
				return [
					service,
					state.exitCode === undefined
						? { state: "stopped" }
						: { state: "stopped", exitCode: state.exitCode },
				];
			return [service, { state: state.healthy === false ? "unhealthy" : "up" }];
		}),
	);
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
		stopped: ({ exitCode }) =>
			exitCode === undefined
				? `${service} stopped`
				: `${service} stopped (exit ${exitCode})`,
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
	runtime: Pick<ContainerRuntimeAdapter, "projectServiceStates">;
	projectName: string;
	/** Compose service names, read on every poll so services can join later. */
	services: () => readonly string[];
	onChange: (changes: ServiceChange[]) => void;
	intervalMs?: number;
}): () => void {
	const controller = new AbortController();
	const intervalMs = input.intervalMs ?? SERVICE_WATCH_INTERVAL_MS;
	let known = new Map<string, ServiceCondition>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const poll = async () => {
		const watched = input.services();
		if (watched.length > 0) {
			const signal = timeoutSignal(intervalMs, controller.signal);
			let states: ServiceRuntimeState[] = [];
			try {
				states = await input.runtime.projectServiceStates(
					input.projectName,
					signal,
				);
			} catch {
				// Unanswered: the same as an empty listing.
			}
			if (controller.signal.aborted) return;
			const next = observeServices(watched, states);
			if (next) {
				const changes = serviceChanges(known, next);
				known = next;
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
