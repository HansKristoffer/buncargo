import { abortableSleep } from "../core/deadline";
import {
	classifyPortOccupant,
	createPortOwnerSnapshotAsync,
	formatPortOwner,
} from "../core/process";
import type { ServiceConfig } from "../types";
import { availableContainerRuntimes } from "./resolve";
import type { ContainerRuntimeAdapter } from "./types";

/** How long a port held by a plain process gets to be released before it counts as taken. */
const RELEASE_GRACE_MS = 2000;

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

	const classify = (owner: ReturnType<typeof snapshot.owner>) =>
		classifyPortOccupant(owner, { ...context, runtime: runtime.name });

	for (const port of targetPorts) {
		let owner = snapshot.owner(port);
		let classification = classify(owner);
		// A runtime's forwarder can hold a port it is about to release: OrbStack
		// keeps listening for about half a second after `docker stop` returns,
		// so `stop` then `dev` read as a foreign process. Containers are
		// attributed, so only a plain process gets the grace.
		const deadline = performance.now() + RELEASE_GRACE_MS;
		while (
			classification === "fail" &&
			owner &&
			!owner.container &&
			performance.now() < deadline
		) {
			await abortableSleep(100, signal);
			owner = (
				await createPortOwnerSnapshotAsync({ runtime, ports: [port], signal })
			).owner(port);
			classification = classify(owner);
		}
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
