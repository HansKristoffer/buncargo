import { existsSync } from "node:fs";
import type { NamedHost } from "../../types";
import { withFileLock } from "../file-lock";
import {
	defineListRegistry,
	isRouteOwnerAlive,
	type ListRegistryReadOptions,
} from "../registry-file";
import { chownToInvokingUser, getRoutesPath } from "./paths";

const REGISTRY_VERSION = 1;

export interface HostsRoute {
	hostname: string;
	port: number;
	kind: "app" | "service";
	name: string;
	root: string;
	pid?: number;
	updatedAt: string;
}

export class HostsRouteConflictError extends Error {
	readonly hostname: string;
	readonly ownerPid?: number;

	constructor(hostname: string, ownerPid?: number) {
		super(
			ownerPid
				? `Hostname ${hostname} is already registered by pid ${ownerPid}`
				: `Hostname ${hostname} is already registered`,
		);
		this.name = "HostsRouteConflictError";
		this.hostname = hostname;
		this.ownerPid = ownerPid;
	}
}

function isHostsRoute(value: unknown): value is HostsRoute {
	if (typeof value !== "object" || value === null) return false;
	const route = value as Partial<HostsRoute>;
	return (
		typeof route.hostname === "string" &&
		typeof route.port === "number" &&
		(route.kind === "app" || route.kind === "service") &&
		typeof route.name === "string" &&
		typeof route.root === "string" &&
		(route.pid === undefined || typeof route.pid === "number")
	);
}

const registry = defineListRegistry<HostsRoute>({
	version: REGISTRY_VERSION,
	key: "routes",
	isEntry: isHostsRoute,
	afterWrite: chownToInvokingUser,
});

export async function loadHostRoutes(
	path = getRoutesPath(),
	options: ListRegistryReadOptions = {},
): Promise<HostsRoute[]> {
	return registry.read(path, options);
}

/**
 * Is this route still attached to something real?
 *
 * Two different deaths. A route with a pid belongs to one run and goes when
 * that run does. A static one — a service URL — has no owner, so nothing would
 * ever retire it; a deleted worktree would keep its hostnames in the registry,
 * and in `/etc/hosts`, forever. The checkout being gone from disk is the only
 * signal that distinguishes "not running" from "no longer exists".
 */
function isRouteLive(
	route: HostsRoute,
	directoryExists: (path: string) => boolean,
): boolean {
	if (route.pid !== undefined) return isRouteOwnerAlive(route.pid);
	return route.root === "" || directoryExists(route.root);
}

/**
 * The registry is shared by every concurrent `buncargo dev` on the machine, so
 * each read-modify-write below runs under `withFileLock`. Without it two runs
 * starting together both read the same snapshot and the second write drops the
 * first one's routes, leaving that project's named URL 404ing with no error.
 *
 * This is the unlocked core so `upsertHostRoutes` can reuse it inside a lock it
 * already holds.
 */
async function prune(
	path: string,
	options: ListRegistryReadOptions & {
		directoryExists?: (path: string) => boolean;
	} = {},
): Promise<HostsRoute[]> {
	const directoryExists = options.directoryExists ?? existsSync;
	const routes = await registry.read(path, options);
	const next = routes.filter((route) => isRouteLive(route, directoryExists));
	if (next.length !== routes.length) {
		await registry.write(path, next);
	}
	return next;
}

export async function pruneHostRoutes(
	path = getRoutesPath(),
	options: ListRegistryReadOptions & {
		directoryExists?: (path: string) => boolean;
	} = {},
): Promise<HostsRoute[]> {
	return withFileLock(path, () => prune(path, options));
}

/**
 * What a registration may do to the live route already holding its hostname.
 *
 * `take` overwrites it, `keep` leaves the existing owner in place, `conflict`
 * refuses.
 */
export type RouteClaim = "take" | "keep" | "conflict";

/**
 * Whether `incoming` may claim a hostname a *live* owner already holds.
 *
 * A different root is always a conflict: two projects cannot share a hostname.
 * Within one root the question is whether this is the same run registering
 * again, or a second `buncargo dev` in the same checkout — the common case
 * when a developer (or an agent) opens a second terminal, where the second run
 * reuses the servers the first one started rather than spawning its own.
 *
 * That second run pointing at the same port is not a competitor, so it is
 * answered with `keep` rather than a throw: the route is already correct, and
 * the live owner must stay the owner. `releaseNamedHosts` drops only routes
 * carrying its own pid, so leaving the first run as owner is what makes the
 * route survive the second run exiting and disappear when the first one does —
 * which is also when the servers it points at go away.
 *
 * Refusing here instead is what left a second run printing `localhost:port`
 * URLs while the named ones were working the whole time.
 */
export function classifyRouteClaim(
	existing: HostsRoute,
	incoming: HostsRoute,
): RouteClaim {
	if (existing.root !== incoming.root) return "conflict";
	// The same run re-registering: refresh it.
	if (existing.pid === incoming.pid) return "take";
	if (existing.port === incoming.port && existing.kind === incoming.kind) {
		return "keep";
	}
	return "conflict";
}

export async function upsertHostRoutes(
	routesToSave: HostsRoute[],
	options: { path?: string; force?: boolean } = {},
): Promise<void> {
	const path = options.path ?? getRoutesPath();
	await withFileLock(path, async () => {
		const routes = await prune(path);
		const byHost = new Map(routes.map((route) => [route.hostname, route]));

		for (const route of routesToSave) {
			const existing = byHost.get(route.hostname);
			if (existing && isRouteOwnerAlive(existing.pid) && !options.force) {
				const claim = classifyRouteClaim(existing, route);
				if (claim === "conflict") {
					throw new HostsRouteConflictError(route.hostname, existing.pid);
				}
				if (claim === "keep") continue;
			}
			byHost.set(route.hostname, route);
		}

		await registry.write(path, Array.from(byHost.values()));
	});
}

export async function removeHostRoutes(
	match: (route: HostsRoute) => boolean,
	path = getRoutesPath(),
): Promise<void> {
	await withFileLock(path, async () => {
		const routes = await registry.read(path);
		await registry.write(
			path,
			routes.filter((route) => !match(route)),
		);
	});
}

export function routesFromPlan(
	plan: NamedHost[],
	input: { root: string; pid?: number; kinds?: Array<NamedHost["kind"]> },
): HostsRoute[] {
	const now = new Date().toISOString();
	return plan
		.filter((entry) => !input.kinds || input.kinds.includes(entry.kind))
		.map((entry) => ({
			hostname: entry.hostname,
			port: entry.targetPort,
			kind: entry.kind,
			name: entry.name,
			root: input.root,
			pid: input.pid,
			updatedAt: now,
		}));
}
