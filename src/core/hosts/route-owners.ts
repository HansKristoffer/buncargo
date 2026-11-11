import type { NamedHost } from "../../types";
import { isProcessAlive } from "../process/lifecycle";
import {
	processIdentityMatcherAsync,
	readProcessIdentitiesCached,
} from "../process-identity";
import {
	type HostsRoute,
	liveNamedHosts,
	loadHostRoutesSync,
	type RouteOwnerCheck,
	type RouteOwners,
} from "./registry";

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
	const recorded = routes.flatMap(({ pid, processIdentity }) =>
		processIdentity === undefined ? [] : [{ pid, processIdentity }],
	);
	const matches = await processIdentityMatcherAsync(recorded);
	const judged = new Set(recorded.map((entry) => entry.pid));
	return ({ pid, processIdentity }) =>
		processIdentity !== undefined && judged.has(pid)
			? matches(pid, processIdentity)
			: isProcessAlive(pid);
};

/**
 * {@link identityRouteOwners} for a synchronous reader: one identity read for
 * the live owners it has not seen before, nothing at all when none is new.
 * `getEnvVar` runs this inside users' configs on every load and reload, so
 * a run's identity is read once per process, not once per call.
 */
function identityRouteOwnersSync(
	routes: readonly HostsRoute[],
): RouteOwnerCheck {
	const recordedLive = routes.flatMap((route) =>
		route.kind === "app" &&
		route.processIdentity !== undefined &&
		isProcessAlive(route.pid)
			? [route.pid]
			: [],
	);
	const identities = readProcessIdentitiesCached(recordedLive);
	return ({ pid, processIdentity }) => {
		if (!isProcessAlive(pid)) return false;
		if (processIdentity === undefined) return true;
		const actual = identities.get(pid);
		return actual === undefined || actual === processIdentity;
	};
}

/**
 * The entries of `root`'s plan whose named URL is live
 * ({@link liveNamedHosts}), read the way a `vite.config.ts` calling
 * `getEnvVar` can: synchronously, from the registry alone.
 */
export function readLiveNamedHostsSync(
	root: string,
	plan: readonly NamedHost[],
): NamedHost[] {
	if (plan.length === 0) return [];
	const routes = loadHostRoutesSync().filter((route) => route.root === root);
	return liveNamedHosts({
		root,
		plan,
		routes,
		ownerAlive: identityRouteOwnersSync(routes),
	});
}
