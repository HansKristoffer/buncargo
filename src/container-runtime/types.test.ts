import { expect, it } from "bun:test";
import type { ContainerRuntimeAdapter } from "./types";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Every member a backend implements; a new one is a decision, made here. */
type PortMembers =
	| "name"
	| "displayName"
	| "capabilities"
	| "availability"
	| "ensureRunning"
	| "containers"
	| "logs"
	| "up"
	| "down"
	| "stop"
	| "exec"
	| "execArgv"
	| "listVolumes"
	| "volumeSizes"
	| "removeVolumes"
	| "listComposeProjectResources"
	| "removeComposeProjectResource";

it("keeps the runtime port to its listed members, every one required", () => {
	const exact: Exactly<keyof ContainerRuntimeAdapter, PortMembers> = true;
	const required: Exactly<
		Required<ContainerRuntimeAdapter>,
		ContainerRuntimeAdapter
	> = true;
	expect([exact, required]).toEqual([true, true]);
});
