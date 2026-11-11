import { isRecord, typedSwitch } from "hanzio";
import type { NamedHost } from "../../types";
import { checkoutDeleted } from "../checkout-presence";
import { withFileLock } from "../file-lock";
import { isProcessAlive } from "../process/lifecycle";
import {
	defineListRegistry,
	type ListRegistryReadOptions,
	readJsonDocumentSync,
	StateFileUnreadableError,
	StateFileVersionError,
} from "../registry-file";
import { chownToInvokingUser } from "../state-paths";
import { getRoutesPath } from "./paths";

const REGISTRY_VERSION = 1;

interface HostsRouteTarget {
	hostname: string;
	port: number;
	name: string;
	root: string;
}

/** An app's route: owned by the run serving it, and gone when that run is. */
export interface AppHostsRoute extends HostsRouteTarget {
	kind: "app";
	pid: number;
	/**
	 * Birth identity of `pid` (`process-identity.ts`). A pid alone outlives a
	 * reboot: reused by another process, it kept a dead run's route live and
	 * held its hostname against the next run of that checkout.
	 */
	processIdentity?: string;
}

/**
 * A service's route: no owner, since its container outlives the run. It goes
 * when its checkout does, or with `dev --down`.
 */
export interface ServiceHostsRoute extends HostsRouteTarget {
	kind: "service";
}

export type HostsRoute = AppHostsRoute | ServiceHostsRoute;

/** The run holding a route, or `undefined` for a service route. */
function routeOwnerPid(route: HostsRoute): number | undefined {
	return route.kind === "app" ? route.pid : undefined;
}

/** Whether an app route's owner is still the run that registered it. */
export type RouteOwnerCheck = (route: AppHostsRoute) => boolean;

/**
 * Builds the owner check for the routes about to be judged, so a check that
 * reads process identity can read them all at once.
 */
export type RouteOwners = (
	routes: readonly AppHostsRoute[],
) => Promise<RouteOwnerCheck>;

/** Owner liveness by pid alone: the one place it is decided that way. */
const pidOwnerAlive: RouteOwnerCheck = (route) => isProcessAlive(route.pid);

/**
 * {@link pidOwnerAlive} as {@link RouteOwners}. The daemon's check: it forks
 * nothing, and reading identity takes a `ps` on macOS. CLI writers pass
 * `identityRouteOwners` and retire a reused pid's routes for it.
 */
export const pidRouteOwners: RouteOwners = async () => pidOwnerAlive;

/** A hostname a live route of another checkout, or another port, holds. */
export class HostsRouteConflictError extends Error {
	readonly hostname: string;
	readonly ownerRoot: string;
	readonly ownerPid?: number;

	constructor(hostname: string, owner: HostsRoute) {
		const pid = routeOwnerPid(owner);
		const by = pid === undefined ? owner.root : `${owner.root} (pid ${pid})`;
		super(
			`${hostname} is already registered by ${by}. Run \`buncargo stop\` in that checkout, or give one of the projects a different \`projectPrefix\`.`,
		);
		this.name = "HostsRouteConflictError";
		this.hostname = hostname;
		this.ownerRoot = owner.root;
		this.ownerPid = pid;
	}
}

function isHostsRoute(value: unknown): value is HostsRoute {
	if (!isRecord(value)) return false;
	const target =
		typeof value.hostname === "string" &&
		typeof value.port === "number" &&
		typeof value.name === "string" &&
		typeof value.root === "string";
	if (!target) return false;
	if (value.kind === "service") return value.pid === undefined;
	return (
		value.kind === "app" &&
		typeof value.pid === "number" &&
		(value.processIdentity === undefined ||
			typeof value.processIdentity === "string")
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
	ownerAlive: RouteOwnerCheck = pidOwnerAlive,
): boolean {
	if (route.kind === "app") return ownerAlive(route);
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

/** The routes still attached to something real ({@link isRouteLive}). */
async function liveRoutes(
	routes: HostsRoute[],
	options: PruneOptions = {},
): Promise<HostsRoute[]> {
	const ownerAlive = await (options.owners ?? pidRouteOwners)(
		routes.filter((route) => route.kind === "app"),
	);
	return routes.filter((route) =>
		isRouteLive(
			route,
			options.directoryExists ?? checkoutStillThere,
			ownerAlive,
		),
	);
}

interface PruneOptions extends ListRegistryReadOptions {
	directoryExists?: (path: string) => boolean;
	/** Defaults to {@link pidRouteOwners}. */
	owners?: RouteOwners;
}

/**
 * The registry is shared by every concurrent `buncargo dev` on the machine, so
 * each read-modify-write here runs under `withFileLock`. Without it two runs
 * starting together both read the same snapshot and the second write drops the
 * first one's routes, leaving that project's named URL 404ing with no error.
 */
export async function pruneHostRoutes(
	path = getRoutesPath(),
	options: PruneOptions = {},
): Promise<HostsRoute[]> {
	return withFileLock(path, async () => {
		const routes = options.strict
			? await readForRewrite(path)
			: await registry.read(path);
		const next = await liveRoutes(routes, options);
		if (next.length !== routes.length) await registry.write(path, next);
		return next;
	});
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
	// The same run re-registering, or a service route again: refresh it.
	if (routeOwnerPid(existing) === routeOwnerPid(incoming)) return "take";
	if (existing.port === incoming.port && existing.kind === incoming.kind) {
		return options.takeover ? "take" : "keep";
	}
	return "conflict";
}

/**
 * Register routes, and return the ones a live owner keeps
 * ({@link classifyRouteClaim}). Those are skipped, not fatal: one name another
 * checkout holds used to drop the whole plan to `localhost:port`.
 *
 * One read under the lock, and no write when nothing changed: an attach that
 * registers what is already there leaves the file alone.
 */
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
): Promise<HostsRouteConflictError[]> {
	const path = options.path ?? getRoutesPath();
	return withFileLock(path, async () => {
		const stored = await readForRewrite(path);
		const routes = await liveRoutes(stored);
		const byHost = new Map(routes.map((route) => [route.hostname, route]));
		const held = routesToSave.flatMap((route) => {
			const existing = byHost.get(route.hostname);
			return existing?.kind === "app" && existing.pid !== routeOwnerPid(route)
				? [existing]
				: [];
		});
		const ownerAlive = await options.owners(held);
		const conflicts: HostsRouteConflictError[] = [];

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
						conflicts.push(
							new HostsRouteConflictError(route.hostname, existing),
						);
						return false;
					},
				});
				if (!take) continue;
			}
			byHost.set(route.hostname, route);
		}

		const next = Array.from(byHost.values());
		if (JSON.stringify(next) !== JSON.stringify(stored)) {
			await registry.write(path, next);
		}
		return conflicts;
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
			route.kind === "app" &&
			route.pid !== run.pid &&
			pidOwnerAlive(route),
	);
	return routes.filter((route) => {
		if (route.root !== run.root) return true;
		if (route.kind === "app") return route.pid !== run.pid;
		return otherRunLive;
	});
}

export async function withdrawHostRoutes(
	run: { root: string; pid: number },
	path = getRoutesPath(),
): Promise<void> {
	await withFileLock(path, async () => {
		const routes = await readForRewrite(path);
		const next = routesAfterWithdraw(routes, run);
		// Most fallbacks registered nothing: no write, and no file created.
		if (next.length === routes.length) return;
		await registry.write(path, next);
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

/**
 * A plan's routes: its apps' owned by the run `owner` names, its services'
 * static.
 */
export function routesFromPlan(
	plan: readonly NamedHost[],
	owner: { root: string; pid: number; processIdentity?: string },
): HostsRoute[] {
	return plan.map((entry): HostsRoute => {
		const target = {
			hostname: entry.hostname,
			port: entry.targetPort,
			name: entry.name,
			root: owner.root,
		};
		if (entry.kind === "service") return { ...target, kind: "service" };
		return {
			...target,
			kind: "app",
			pid: owner.pid,
			...(owner.processIdentity === undefined
				? {}
				: { processIdentity: owner.processIdentity }),
		};
	});
}
