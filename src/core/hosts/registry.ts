import type { NamedHost } from "../../types";
import { defineListRegistry, isRouteOwnerAlive } from "../registry-file";
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
): Promise<HostsRoute[]> {
	return registry.read(path);
}

export async function pruneHostRoutes(
	path = getRoutesPath(),
): Promise<HostsRoute[]> {
	const routes = await registry.read(path);
	const next = routes.filter((route) => isRouteOwnerAlive(route.pid));
	if (next.length !== routes.length) {
		await registry.write(path, next);
	}
	return next;
}

export async function upsertHostRoutes(
	routesToSave: HostsRoute[],
	options: { path?: string; force?: boolean } = {},
): Promise<void> {
	const path = options.path ?? getRoutesPath();
	const routes = await pruneHostRoutes(path);
	const byHost = new Map(routes.map((route) => [route.hostname, route]));

	for (const route of routesToSave) {
		const existing = byHost.get(route.hostname);
		if (existing && isRouteOwnerAlive(existing.pid) && !options.force) {
			const sameOwner =
				existing.pid === route.pid && existing.root === route.root;
			const existingStatic = existing.pid === undefined;
			const incomingStatic = route.pid === undefined;
			if (
				!sameOwner &&
				!(existingStatic && incomingStatic && existing.root === route.root)
			) {
				throw new HostsRouteConflictError(route.hostname, existing.pid);
			}
		}
		byHost.set(route.hostname, route);
	}

	await registry.write(path, Array.from(byHost.values()));
}

export async function removeHostRoutes(
	match: (route: HostsRoute) => boolean,
	path = getRoutesPath(),
): Promise<void> {
	const routes = await registry.read(path);
	await registry.write(
		path,
		routes.filter((route) => !match(route)),
	);
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
