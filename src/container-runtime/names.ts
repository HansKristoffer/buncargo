import type { ContainerRuntimeName, ContainerRuntimeSelection } from "../types";

/**
 * Runtime names and the selection guard, kept free of any adapter import.
 *
 * Config validation needs the guard, and every adapter needs the names; a
 * shared leaf module keeps `src/config` from pulling in the runtimes it is
 * only validating a string against.
 */

export const CONTAINER_RUNTIME_NAMES = ["docker", "apple"] as const;

export const CONTAINER_RUNTIME_SELECTIONS = [
	...CONTAINER_RUNTIME_NAMES,
	"auto",
] as const;

export const DEFAULT_CONTAINER_RUNTIME: ContainerRuntimeName = "docker";

export function isContainerRuntimeName(
	value: unknown,
): value is ContainerRuntimeName {
	return CONTAINER_RUNTIME_NAMES.includes(value as ContainerRuntimeName);
}

export function isContainerRuntimeSelection(
	value: unknown,
): value is ContainerRuntimeSelection {
	return CONTAINER_RUNTIME_SELECTIONS.includes(
		value as ContainerRuntimeSelection,
	);
}

/** Human-readable name used in status output and error messages. */
export function containerRuntimeDisplayName(
	name: ContainerRuntimeName,
): string {
	switch (name) {
		case "docker":
			return "Docker";
		case "apple":
			return "Apple container";
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
}
