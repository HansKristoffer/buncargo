import type { ContainerGroup } from "./inventory";
import type { ForeignStack, SweepResult } from "./sweep";

/**
 * The foreign stack a sweep reported for `group`, if it reported one.
 *
 * A leaf of its own: the watchdog loop asks it, and `core/watchdog.ts`, which
 * every run loads, must not pull the sweep in with it.
 */
export function foreignStackOf(
	result: Pick<SweepResult, "foreign">,
	group: Pick<ContainerGroup, "projectName" | "root" | "runtime">,
): ForeignStack | undefined {
	return result.foreign.find(
		(stack) =>
			stack.projectName === group.projectName &&
			stack.root === group.root &&
			stack.runtime === group.runtime,
	);
}
