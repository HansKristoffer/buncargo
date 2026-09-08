import type { ContainerRuntimeName, ServiceConfig } from "../types";

/** Check before startup mutations, and again at the direct runtime API boundary. */
export function assertServiceCapabilities(
	runtime: ContainerRuntimeName,
	services: Record<string, ServiceConfig>,
): void {
	if (runtime !== "apple") {
		return;
	}

	// A running process is not proof of successful job completion. Until Apple
	// supplies reliable exit codes, accepting a job would weaken its contract.
	if (Object.values(services).some((service) => service.kind === "job")) {
		throw new Error(
			"Apple container cannot verify finite job exit codes yet. Use --runtime=docker.",
		);
	}
}
