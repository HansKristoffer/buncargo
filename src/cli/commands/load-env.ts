import { getErrorMessage } from "hanzio";
import { unallocatedPortsMessage } from "../../core/port-exhaustion";
import * as log from "../log";

export async function loadEnv(
	options: { containerRuntime?: string; readOnly?: boolean } = {},
) {
	try {
		return await (await import("../../loader")).loadDevEnv(options);
	} catch (error) {
		log.fail(getErrorMessage(error));
	}
}

/**
 * The environment as this checkout's live run sees it: the named URLs a run
 * of it serves, entry by entry as `getEnvVar` reads them, and what the run's
 * apps printed.
 */
export async function loadLiveEnv() {
	const { readLiveNamedUrls } = await import("../../core/checkout-view");
	const { adoptLiveCaptures } = await import("../../core/run-publish");
	const env = await loadEnv({ readOnly: true });
	// Answered all the same (`portOffsetProvenance: "unallocated"`): these
	// commands are how an agent finds its way out of a full range.
	if (env.portOffsetProvenance === "unallocated")
		log.warn(unallocatedPortsMessage(env.root));
	const live = env.hosts
		? readLiveNamedUrls(
				env.root,
				env.hosts.plan,
				env.ports as Record<string, number>,
			)
		: undefined;
	if (live) env.setNamedHostsActive(true, live);
	await adoptLiveCaptures(env);
	return env;
}
