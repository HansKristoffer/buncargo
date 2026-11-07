import { isRecord, typedSwitch } from "hanzio";
import type { NamedHost } from "../../types";
import { checkoutDeleted } from "../checkout-presence";
import { withFileLock } from "../file-lock";
import {
	defineListRegistry,
	isRouteOwnerAlive,
	type ListRegistryReadOptions,
	readJsonDocumentSync,
	StateFileUnreadableError,
	StateFileVersionError,
} from "../registry-file";
import { chownToInvokingUser } from "../state-paths";
import { getRoutesPath } from "./paths";

const REGISTRY_VERSION = 1;

export interface HostsRoute {
	hostname: string;
	port: number;
	kind: "app" | "service";
	name: string;
	root: string;
	pid?: number;
	/**
	 * Birth identity of `pid` (`process-identity.ts`). A pid alone outlives a
	 * reboot: reused by another process, it kept a dead run's route live and
	 * held its hostname against the next run of that checkout.
	 */
	processIdentity?: string;
	updatedAt: string;
}

/** Whether a route's owner is still the run that registered it. */
export type RouteOwnerCheck = (route: HostsRoute) => boolean;

/**
 * Builds the owner check for the routes about to be judged, so a check that
 * reads process identity can read them all at once.
 */
export type RouteOwners = (
	routes: readonly HostsRoute[],
) => Promise<RouteOwnerCheck>;

/**
 * Owner liveness by pid alone. The daemon's check: it forks nothing, and
 * reading identity takes a `ps` on macOS. CLI writers pass
 * `identityRouteOwners` and retire a reused pid's routes for it.
 */
export const pidRouteOwners: RouteOwners = async () => (route) =>
	isRouteOwnerAlive(route.pid);

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
		(route.pid === undefined || typeof route.pid === "number") &&
		(route.processIdentity === undefined ||
			typeof route.processIdentity === "string")
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

/** {@link loadHostRoutes} for `getEnvVar`, which is synchronous; lenient. */
export function loadHostRoutesSync(path = getRoutesPath()): HostsRoute[] {
	const routes = readJsonDocumentSync(path, (value) =>
		isRecord(value) &&
		value.version === REGISTRY_VERSION &&
		Array.isArray(value.routes)
			? value.routes.filter(isHostsRoute)
			: undefined,
	);
	return routes ?? [];
}

/**
 * The entries of a checkout's plan whose named URL is live: its hostname is
 * registered for the checkout, at the plan's port, by an owner still running.
 * The others stay on `localhost:port`.
 *
 * The one answer `buncargo env`, `status`, `open` and `getEnvVar` give. A run
 * that falls back to `localhost:port` withdraws what it registered, so a live
 * registration is a run that confirmed the daemon serves it. Planning alone
 * used to hand a `vite.config.ts` https URLs while the run was on
 * `localhost:port`, or with no run at all.
 *
 * Per entry, not all or nothing: a takeover that ends removes the one app's
 * route it took, and every other app of the run, still on its named URL,
 * read `localhost:port` from `getEnvVar`.
 */
export function liveNamedHosts(input: {
	root: string;
	plan: readonly NamedHost[];
	routes: readonly HostsRoute[];
	ownerAlive: RouteOwnerCheck;
}): NamedHost[] {
	const { root, plan, routes, ownerAlive } = input;
	return plan.filter((entry) =>
		routes.some(
			(route) =>
				route.root === root &&
				route.hostname === entry.hostname &&
				route.port === entry.targetPort &&
				isRouteLive(route, checkoutStillThere, ownerAlive),
		),
	);
}

function checkoutStillThere(root: string): boolean {
	return !checkoutDeleted(root);
}

/**
 * Is this route still attached to something real?
 *
 * Two different deaths. A route with a pid belongs to one run and goes when
 * that run does. A static one — a service URL — has no owner, so nothing would
 * ever retire it; a deleted worktree would keep its hostnames in the registry,
 * and in `/etc/hosts`, forever. The checkout being gone from disk is the only
 * signal that distinguishes "not running" from "no longer exists"; one this
 * user cannot read is not gone.
 */
export function isRouteLive(
	route: HostsRoute,
	directoryExists: (path: string) => boolean = checkoutStillThere,
	ownerAlive: RouteOwnerCheck = (owned) => isRouteOwnerAlive(owned.pid),
): boolean {
	if (route.pid !== undefined) return ownerAlive(route);
	return route.root === "" || directoryExists(route.root);
}

/**
 * Read the registry to rewrite it, refusing one that cannot be read.
 *
 * Every project's routes are in this one file. Read leniently, a corrupt file
 * came back empty and the writer replaced it with only its own routes, so
 * every other project's named URLs went with no error at all.
 */
async function readForRewrite(path: string): Promise<HostsRoute[]> {
	try {
		return await registry.read(path, { strict: true });
	} catch (error) {
		const unreadable =
			error instanceof StateFileUnreadableError &&
			!(error instanceof StateFileVersionError);
		if (!unreadable) throw error;
		const message = `${error.message}. Rewriting it would drop every other project's named routes: fix or delete it, then restart this run.`;
		throw new Error(message, { cause: error });
	}
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
	options: PruneOptions = {},
): Promise<HostsRoute[]> {
	const directoryExists = options.directoryExists ?? checkoutStillThere;
	const routes = options.strict
		? await readForRewrite(path)
		: await registry.read(path);
	const ownerAlive = await (options.owners ?? pidRouteOwners)(
		routes.filter((route) => route.pid !== undefined),
	);
	const next = routes.filter((route) =>
		isRouteLive(route, directoryExists, ownerAlive),
	);
	if (next.length !== routes.length) {
		await registry.write(path, next);
	}
	return next;
}

interface PruneOptions extends ListRegistryReadOptions {
	directoryExists?: (path: string) => boolean;
	/** Defaults to {@link pidRouteOwners}. */
	owners?: RouteOwners;
}

export async function pruneHostRoutes(
	path = getRoutesPath(),
	options: PruneOptions = {},
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
 *
 * A takeover is the exception. It has stopped the first run's server and
 * serves the port itself, but the first `buncargo dev` is still alive, so
 * leaving it as owner would let its exit delete the route from under the run
 * now serving it.
 */
export function classifyRouteClaim(
	existing: HostsRoute,
	incoming: HostsRoute,
	options: { takeover?: boolean } = {},
): RouteClaim {
	if (existing.root !== incoming.root) return "conflict";
	// The same run re-registering: refresh it.
	if (existing.pid === incoming.pid) return "take";
	if (existing.port === incoming.port && existing.kind === incoming.kind) {
		return options.takeover ? "take" : "keep";
	}
	return "conflict";
}

export async function upsertHostRoutes(
	routesToSave: HostsRoute[],
	options: {
		path?: string;
		/**
		 * Route names (apps) this run took over from another run of the same
		 * checkout. Only those change owner: the other run still serves the rest.
		 */
		takeover?: ReadonlySet<string>;
		/**
		 * Who still owns the routes holding these hostnames. Asked only about
		 * those, so a run with nobody in its way forks nothing.
		 */
		owners: RouteOwners;
	},
): Promise<void> {
	const path = options.path ?? getRoutesPath();
	await withFileLock(path, async () => {
		const routes = await prune(path, { strict: true });
		const byHost = new Map(routes.map((route) => [route.hostname, route]));
		const held = routesToSave.flatMap((route) => {
			const existing = byHost.get(route.hostname);
			return existing?.pid !== undefined && existing.pid !== route.pid
				? [existing]
				: [];
		});
		const ownerAlive = await options.owners(held);

		for (const route of routesToSave) {
			const existing = byHost.get(route.hostname);
			if (existing && isRouteLive(existing, checkoutStillThere, ownerAlive)) {
				const claim = classifyRouteClaim(existing, route, {
					takeover: options.takeover?.has(route.name),
				});
				const take = typedSwitch(claim, {
					take: () => true,
					keep: () => false,
					conflict: () => {
						throw new HostsRouteConflictError(route.hostname, existing.pid);
					},
				});
				if (!take) continue;
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
		const routes = await readForRewrite(path);
		await registry.write(
			path,
			routes.filter((route) => !match(route)),
		);
	});
}

/**
 * The routes left once a run that fell back to `localhost:port` withdraws:
 * its own, and the checkout's service routes unless another live run of the
 * checkout still holds routes there. Left registered, they read as named URLs
 * being live to everything but the run itself.
 */
export function routesAfterWithdraw(
	routes: readonly HostsRoute[],
	run: { root: string; pid: number },
): HostsRoute[] {
	const otherRunLive = routes.some(
		(route) =>
			route.root === run.root &&
			route.pid !== undefined &&
			route.pid !== run.pid &&
			isRouteOwnerAlive(route.pid),
	);
	return routes.filter((route) => {
		if (route.root !== run.root) return true;
		if (route.pid === run.pid) return false;
		return route.pid !== undefined || otherRunLive;
	});
}

export async function withdrawHostRoutes(
	run: { root: string; pid: number },
	path = getRoutesPath(),
): Promise<void> {
	await withFileLock(path, async () => {
		const routes = await readForRewrite(path);
		await registry.write(path, routesAfterWithdraw(routes, run));
	});
}

/**
 * Drop every route, readable or not: `hosts uninstall`. A file that cannot
 * be read is kept beside it as a recovery copy, never just deleted.
 */
export async function clearHostRoutes(path = getRoutesPath()): Promise<void> {
	await withFileLock(path, () => registry.write(path, []));
}

/**
 * What `dev --down` takes out of the registry: this checkout's service
 * routes, whose containers it stops. Not app routes: another live run of the
 * checkout still serves those, and removing them 404'd its named URLs.
 */
export function routesDownRemoves(
	root: string,
): (route: HostsRoute) => boolean {
	return (route) => route.root === root && route.kind === "service";
}

export function routesFromPlan(
	plan: NamedHost[],
	input: {
		root: string;
		pid?: number;
		processIdentity?: string;
		kinds?: Array<NamedHost["kind"]>;
	},
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
			...(input.pid !== undefined && input.processIdentity !== undefined
				? { processIdentity: input.processIdentity }
				: {}),
			updatedAt: now,
		}));
}
