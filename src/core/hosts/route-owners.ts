import type { NamedHost } from "../../types";
import { isProcessAlive } from "../process/lifecycle";
import {
	processIdentityMatcherAsync,
	readProcessIdentities,
} from "../process-identity";
import { isRouteOwnerAlive } from "../registry-file";
import {
	type HostsRoute,
	isNamedHostPlanLive,
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

/**
 * {@link identityRouteOwners} for a synchronous reader: one identity read for
 * every live owner that recorded one, nothing at all when none is alive.
 */
function identityRouteOwnersSync(
	routes: readonly HostsRoute[],
): RouteOwnerCheck {
	const recordedLive = routes.flatMap((route) =>
		route.pid !== undefined &&
		route.processIdentity !== undefined &&
		isProcessAlive(route.pid)
			? [route.pid]
			: [],
	);
	const identities = readProcessIdentities(recordedLive);
	return ({ pid, processIdentity }) => {
		if (!isRouteOwnerAlive(pid)) return false;
		if (pid === undefined || processIdentity === undefined) return true;
		const actual = identities.get(pid);
		return actual === undefined || actual === processIdentity;
	};
}

/**
 * Whether `root`'s named URLs are live ({@link isNamedHostPlanLive}), read
 * the way a `vite.config.ts` calling `getEnvVar` can: synchronously, from
 * the registry alone.
 */
export function readNamedHostsLiveSync(
	root: string,
	plan: readonly NamedHost[],
): boolean {
	if (plan.length === 0) return false;
	const routes = loadHostRoutesSync().filter((route) => route.root === root);
	return isNamedHostPlanLive({
		root,
		plan,
		routes,
		ownerAlive: identityRouteOwnersSync(routes),
	});
}
