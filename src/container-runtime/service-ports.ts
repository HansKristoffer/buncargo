import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
} from "../core/process";
import type { ServiceConfig } from "../types";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * Fail early when a foreign process or container already holds a service port.
 */
export async function assertServicePortsClaimable(
	runtime: ContainerRuntimeAdapter,
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	context: { root: string; projectName: string },
	signal?: AbortSignal,
): Promise<void> {
	const targetPorts = Object.keys(services)
		.flatMap((serviceKey) => [
			ports[serviceKey],
			ports[`${serviceKey}Secondary`],
		])
		.filter((port): port is number => port !== undefined);
	if (targetPorts.length === 0) {
		return;
	}

	const snapshot = await createPortOwnerSnapshotAsync({
		runtime,
		ports: targetPorts,
		signal,
	});
	let diagnosticSnapshot:
		| Awaited<ReturnType<typeof createPortOwnerSnapshotAsync>>
		| undefined;

	for (const port of targetPorts) {
		const owner = snapshot.owner(port);
		const classification = classifyPortOccupant(owner, {
			...context,
			runtime: runtime.name,
		});
		if (classification === "fail" && owner) {
			diagnosticSnapshot ??= await createPortOwnerSnapshotAsync({
				signal,
				runtime,
				ports: targetPorts,
				fallbackRuntimes: availableContainerRuntimes().filter(
					(candidate) => candidate.name !== runtime.name,
				),
			});
			throw new Error(
				formatPortOwner(port, diagnosticSnapshot.owner(port) ?? owner, {
					runtime: runtime.name,
				}),
			);
		}
	}
}
