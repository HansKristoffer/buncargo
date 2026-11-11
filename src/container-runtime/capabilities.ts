import type { ResolvedService } from "../types";
import type { ContainerRuntimeAdapter } from "./types";

/** Check before startup mutations, and again at the direct runtime API boundary. */
export function assertServiceCapabilities(
	runtime: Pick<ContainerRuntimeAdapter, "capabilities" | "displayName">,
	services: Readonly<Record<string, ResolvedService>>,
): void {
	const hasJob = Object.values(services).some(
		(service) => service.kind === "job",
	);
	if (hasJob && !runtime.capabilities.jobExitCodes) {
		throw new Error(
			`${runtime.displayName} cannot verify finite job exit codes yet. Use --runtime=docker.`,
		);
	}
}
