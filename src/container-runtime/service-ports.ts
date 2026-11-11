import { isDefined } from "hanzio";
import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
} from "../core/process";
import type { PortContainerOwner, ServiceConfig } from "../types";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/**
 * Fail early when a foreign process or container already holds a service port.
 */
export async function assertServicePortsClaimable(
	runtime: ContainerRuntimeAdapter,
	services: Record<string, ServiceConfig>,
	ports: Record<string, number>,
	context: {
		root: string;
		projectName: string;
		projectPrefix?: string;
		/** The runtime's container owners, when the caller has just listed them. */
		containerOwners?: Map<number, PortContainerOwner>;
	},
	signal?: AbortSignal,
): Promise<void> {
	const targetPorts = Object.keys(services)
		.flatMap((serviceKey) => [
			ports[serviceKey],
			ports[`${serviceKey}Secondary`],
		])
		.filter(isDefined);
	if (targetPorts.length === 0) {
		return;
	}

	const snapshot = await createPortOwnerSnapshotAsync({
		runtime,
		ports: targetPorts,
		containers: context.containerOwners,
		signal,
	});
	let diagnosticSnapshot:
		Awaited<ReturnType<typeof createPortOwnerSnapshotAsync>> | undefined;

	for (const port of targetPorts) {
		const owner = snapshot.owner(port);
		const classification = classifyPortOccupant(owner, {
			root: context.root,
			projectName: context.projectName,
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
					checkout:
						context.projectPrefix === undefined
							? undefined
							: { root: context.root, projectPrefix: context.projectPrefix },
				}),
			);
		}
	}
}
