import { processIdentityMatcherAsync } from "../process-identity";
import { isRouteOwnerAlive } from "../registry-file";
import type { RouteOwners } from "./registry";

/**
 * Route owners judged by process identity, for the CLI's registry writers.
 *
 * Its own module so the daemon, which reaches the registry but must fork
 * nothing, does not carry it: on macOS reading identity takes one `ps` for
 * the whole list. A route with no recorded identity is judged by its pid, and
 * one whose identity cannot be read counts as live, as everywhere liveness is
 * decided.
 */
export const identityRouteOwners: RouteOwners = async (routes) => {
	const recorded = routes.flatMap((route) =>
		route.pid === undefined || route.processIdentity === undefined
			? []
			: [{ pid: route.pid, processIdentity: route.processIdentity }],
	);
	const matches = await processIdentityMatcherAsync(recorded);
	const judged = new Set(recorded.map((entry) => entry.pid));
	return ({ pid, processIdentity }) => {
		if (pid === undefined || processIdentity === undefined)
			return isRouteOwnerAlive(pid);
		return judged.has(pid)
			? matches(pid, processIdentity)
			: isRouteOwnerAlive(pid);
	};
};
