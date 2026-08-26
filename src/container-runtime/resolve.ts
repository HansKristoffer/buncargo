import { appleContainerRuntimeAdapter } from "../apple-container";
import {
	containerBinaryOverride,
	containerRuntimeOverride,
} from "../core/runtime-flags";
import { dockerRuntimeAdapter } from "../docker/adapter";
import type {
	ContainerRuntimeName,
	ContainerRuntimeSelection,
	DockerComposeGenerationOptions,
} from "../types";
import {
	CONTAINER_RUNTIME_SELECTIONS,
	DEFAULT_CONTAINER_RUNTIME,
	isContainerRuntimeSelection,
} from "./names";
import type { ContainerRuntimeAdapter } from "./types";

export interface ResolveContainerRuntimeOptions {
	/** `--runtime`, the highest precedence source. */
	flag?: string;
	docker?: DockerComposeGenerationOptions;
	env?: NodeJS.ProcessEnv;
}

function assertSelection(
	value: string,
	source: string,
): ContainerRuntimeSelection {
	if (!isContainerRuntimeSelection(value)) {
		throw new Error(
			`${source} "${value}" is invalid. Use ${CONTAINER_RUNTIME_SELECTIONS.map((name) => `"${name}"`).join(", ")}.`,
		);
	}
	return value;
}

/**
 * Which runtime was asked for, before checking whether it is usable.
 *
 * Precedence is most-specific-first: an explicit `--runtime` beats the
 * environment, which beats the config, which defaults to Docker. The default
 * is deliberately not `"auto"` - silently moving an existing project onto a
 * different runtime because a binary happens to be installed would change
 * where its data lives.
 */
export function resolveContainerRuntimeSelection(
	options: ResolveContainerRuntimeOptions = {},
): ContainerRuntimeSelection {
	const { flag, docker, env = process.env } = options;

	if (flag !== undefined) {
		return assertSelection(flag, "--runtime");
	}

	const fromEnv = containerRuntimeOverride(env);
	if (fromEnv !== undefined) {
		return assertSelection(fromEnv, "BUNCARGO_CONTAINER_RUNTIME");
	}

	return docker?.runtime ?? DEFAULT_CONTAINER_RUNTIME;
}

export interface ContainerRuntimeAdapterOptions {
	/**
	 * Path to the selected runtime's binary.
	 *
	 * There is one option rather than one per backend because only the selected
	 * runtime is ever executed, so naming which one it belongs to would be a
	 * second thing to keep in sync with `docker.runtime`.
	 */
	binary?: string;
}

/**
 * Which binary the selected runtime should be executed as.
 *
 * Config beats the environment for the same reason the runtime choice does:
 * a project that pins its binary should not be redirected by a stray export.
 *
 * Returns nothing under `"auto"`: there is one override for two backends, so
 * until a runtime is chosen the path cannot be attributed to either, and
 * guessing would mean probing for Apple's `container` by executing whatever
 * `docker` was pinned to. Config validation rejects the pairing outright; this
 * covers the environment variable, which has no config to validate.
 */
export function resolveContainerRuntimeBinary(
	options: ResolveContainerRuntimeOptions = {},
): string | undefined {
	if (resolveContainerRuntimeSelection(options) === "auto") return undefined;
	return (
		options.docker?.binary ??
		containerBinaryOverride(options.env ?? process.env)
	);
}

export function getContainerRuntimeAdapter(
	name: ContainerRuntimeName,
	options: ContainerRuntimeAdapterOptions = {},
): ContainerRuntimeAdapter {
	switch (name) {
		case "docker":
			return dockerRuntimeAdapter(options);
		case "apple":
			return appleContainerRuntimeAdapter(options);
		default: {
			const _exhaustive: never = name;
			return _exhaustive;
		}
	}
}

/**
 * Resolve the selection to a concrete backend.
 *
 * Only `"auto"` probes: an explicit choice is returned even when its daemon is
 * down, so the failure surfaces later as that runtime's own remediation
 * message instead of a silent fallback to the other one.
 */
export function resolveContainerRuntime(
	options: ResolveContainerRuntimeOptions = {},
): ContainerRuntimeAdapter {
	const selection = resolveContainerRuntimeSelection(options);
	const binary = resolveContainerRuntimeBinary(options);

	if (selection !== "auto") {
		return getContainerRuntimeAdapter(selection, { binary });
	}

	// Probed on PATH: `binary` is undefined here by construction, so neither
	// runtime is ever probed by running the other one's binary.
	const apple = getContainerRuntimeAdapter("apple");
	return apple.isAvailable() ? apple : getContainerRuntimeAdapter("docker");
}

/**
 * Every backend that could run containers on this machine right now.
 *
 * `binary` applies only to `runtime`, because it names one backend's
 * executable: applying it to both would probe for Apple's `container` by
 * running a pinned `docker`, and report the wrong one down.
 */
export function availableContainerRuntimes(
	options: ContainerRuntimeAdapterOptions & {
		/** The backend `binary` belongs to. */
		runtime?: ContainerRuntimeName;
		env?: NodeJS.ProcessEnv;
	} = {},
): ContainerRuntimeAdapter[] {
	const binary =
		options.binary ?? containerBinaryOverride(options.env ?? process.env);
	const binaryFor = (name: ContainerRuntimeName) =>
		options.runtime === undefined || options.runtime === name
			? binary
			: undefined;

	return [
		getContainerRuntimeAdapter("docker", { binary: binaryFor("docker") }),
		getContainerRuntimeAdapter("apple", { binary: binaryFor("apple") }),
	].filter((adapter) => adapter.isAvailable());
}

/**
 * Rebuild the adapter a finished environment resolved.
 *
 * The name and the binary have to travel together, so callers holding a
 * `DevEnvironment` go through this rather than passing the name alone and
 * silently losing a configured `docker.binary`.
 */
export function containerRuntimeForEnv(env: {
	containerRuntime: ContainerRuntimeName;
	containerRuntimeBinary?: string;
}): ContainerRuntimeAdapter {
	return getContainerRuntimeAdapter(env.containerRuntime, {
		binary: env.containerRuntimeBinary,
	});
}
