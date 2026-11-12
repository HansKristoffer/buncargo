import { describe, expect, it } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readCurrentProcessIdentity } from "../process-identity";
import { useTempHome } from "../test-env.testing";
import { getRoutesPath } from "./paths";
import {
	type AppHostsRoute,
	classifyRouteClaim,
	clearHostRoutes,
	type HostsRoute,
	liveNamedHosts,
	loadHostRoutes,
	pidRouteOwners,
	pruneHostRoutes,
	removeHostRoutes,
	routesAfterWithdraw,
	routesDownRemoves,
	routesFromPlan,
	upsertHostRoutes,
} from "./registry";
import { identityRouteOwners } from "./route-owners";

const home = useTempHome();

/** The test's own `HOME`, and the `routes.json` inside it. */
async function tempRegistry(): Promise<{ path: string; dir: string }> {
	const dir = home();
	const path = getRoutesPath();
	await mkdir(dirname(path), { recursive: true });
	return { dir, path };
}

describe("hosts registry", () => {
	it("upserts routes and loads them back", async () => {
		await tempRegistry();
		await upsertHostRoutes(
			[
				{
					hostname: "api.serpier.localhost",
					port: 3000,
					kind: "app",
					name: "api",
					root: "/repo",
					pid: process.pid,
				},
			],
			{ owners: pidRouteOwners },
		);
		const routes = await loadHostRoutes();
		expect(routes).toHaveLength(1);
		expect(routes[0]?.hostname).toBe("api.serpier.localhost");
	});

	it("takes over a route whose owner pid is dead", async () => {
		await tempRegistry();
		await upsertHostRoutes(
			[
				{
					hostname: "api.serpier.localhost",
					port: 3000,
					kind: "app",
					name: "api",
					root: "/old",
					pid: 99999999,
				},
			],
			{ owners: pidRouteOwners },
		);
		await upsertHostRoutes(
			[
				{
					hostname: "api.serpier.localhost",
					port: 3100,
					kind: "app",
					name: "api",
					root: "/new",
					pid: process.pid,
				},
			],
			{ owners: pidRouteOwners },
		);
		const routes = await loadHostRoutes();
		expect(routes[0]?.port).toBe(3100);
		expect(routes[0]?.root).toBe("/new");
	});

	// One name another checkout holds used to throw, and the run dropped its
	// whole plan to localhost:port; the message named a pid and nothing else.
	it("registers the rest of the plan and names the checkout holding a hostname", async () => {
		await tempRegistry();
		const at = (hostname: string, root: string): HostsRoute => ({
			hostname,
			port: 3000,
			kind: "app",
			name: hostname.split(".")[0] as string,
			root,
			pid: process.pid,
		});
		await upsertHostRoutes([at("api.serpier.localhost", "/a")], {
			owners: pidRouteOwners,
		});

		const conflicts = await upsertHostRoutes(
			[at("api.serpier.localhost", "/b"), at("web.serpier.localhost", "/b")],
			// A takeover is within one checkout; it never crosses projects.
			{ takeover: new Set(["api"]), owners: pidRouteOwners },
		);

		expect(conflicts.map((conflict) => conflict.message)).toEqual([
			`api.serpier.localhost is already registered by /a (pid ${process.pid}). Run \`buncargo stop\` in that checkout, or give one of the projects a different \`projectPrefix\`.`,
		]);
		const routes = await loadHostRoutes();
		expect(routes.map((route) => [route.hostname, route.root]).sort()).toEqual([
			["api.serpier.localhost", "/a"],
			["web.serpier.localhost", "/b"],
		]);
	});

	it("prunes dead-pid routes and keeps static service routes", async () => {
		const { dir } = await tempRegistry();
		await upsertHostRoutes(
			[
				{
					hostname: "api.serpier.localhost",
					port: 3000,
					kind: "app",
					name: "api",
					root: "/repo",
					pid: 99999999,
				},
				{
					hostname: "mailpit.serpier.localhost",
					port: 8025,
					kind: "service",
					name: "mailpit",
					root: dir,
				},
			],
			{ owners: pidRouteOwners },
		);
		const pruned = await pruneHostRoutes();
		expect(pruned.map((route) => route.hostname)).toEqual([
			"mailpit.serpier.localhost",
		]);
	});

	// The second run must not become the owner: `releaseNamedHosts` filters by
	// pid, so the route has to disappear when the run that owns the servers
	// exits, not when the reusing run does.
	it("keeps the first run as owner when a second run registers the same route", async () => {
		await tempRegistry();
		const route: AppHostsRoute = {
			hostname: "api.serpier.localhost",
			port: 3000,
			kind: "app",
			name: "api",
			root: "/repo",
			pid: process.pid,
		};
		await upsertHostRoutes([route], { owners: pidRouteOwners });
		await upsertHostRoutes([{ ...route, pid: process.pid + 1 }], {
			owners: pidRouteOwners,
		});

		const saved = await loadHostRoutes();
		expect(saved).toMatchObject([{ pid: process.pid }]);
	});

	// A takeover stops the first run's server but not the first `buncargo dev`,
	// which goes on to release the routes carrying its pid. Left as owner, it
	// deleted the named URLs of the run that took over.
	it("moves a taken-over route to the new run and leaves the rest", async () => {
		await tempRegistry();
		const first = process.pid;
		const second = process.pid + 1;
		const api: AppHostsRoute = {
			hostname: "api.serpier.localhost",
			port: 3000,
			kind: "app",
			name: "api",
			root: "/repo",
			pid: first,
		};
		const web: AppHostsRoute = {
			...api,
			hostname: "web.serpier.localhost",
			port: 3001,
			name: "web",
		};
		await upsertHostRoutes([api, web], { owners: pidRouteOwners });
		await upsertHostRoutes(
			[
				{ ...api, pid: second },
				{ ...web, pid: second },
			],
			{ takeover: new Set(["api"]), owners: pidRouteOwners },
		);
		await removeHostRoutes(
			(route) => route.kind === "app" && route.pid === first,
		);

		expect(await loadHostRoutes()).toMatchObject([
			{ name: "api", pid: second },
		]);
	});

	// Nothing retires a static route on its own, so a deleted worktree would
	// keep its hostnames in the registry — and in /etc/hosts — forever.
	it("drops a static route whose checkout has been deleted", async () => {
		await tempRegistry();
		await upsertHostRoutes(
			[
				{
					hostname: "mailpit.serpier.localhost",
					port: 8025,
					kind: "service",
					name: "mailpit",
					root: "/repo/worktrees/gone",
				},
			],
			{ owners: pidRouteOwners },
		);
		const pruned = await pruneHostRoutes();
		expect(pruned).toEqual([]);
	});

	it("keeps a static route whose checkout is still there", async () => {
		const { dir } = await tempRegistry();
		await upsertHostRoutes(
			[
				{
					hostname: "mailpit.serpier.localhost",
					port: 8025,
					kind: "service",
					name: "mailpit",
					root: dir,
				},
			],
			{ owners: pidRouteOwners },
		);
		expect(await pruneHostRoutes()).toHaveLength(1);
	});

	it("removes routes by predicate", async () => {
		await tempRegistry();
		await upsertHostRoutes(
			[
				{
					hostname: "api.serpier.localhost",
					port: 3000,
					kind: "app",
					name: "api",
					root: "/repo",
					pid: process.pid,
				},
			],
			{ owners: pidRouteOwners },
		);
		await removeHostRoutes(
			(route) => route.root === "/repo" && route.kind === "app",
		);
		expect(await loadHostRoutes()).toEqual([]);
	});
});

describe("classifyRouteClaim", () => {
	const base: AppHostsRoute = {
		hostname: "api.serpier.localhost",
		port: 3000,
		kind: "app",
		name: "api",
		root: "/repo",
		pid: 100,
	};

	it("refuses a different project", () => {
		expect(
			classifyRouteClaim(base, { ...base, root: "/other", pid: 200 }),
		).toBe("conflict");
	});

	it("refreshes the same run's own route", () => {
		expect(classifyRouteClaim(base, { ...base, port: 3001 })).toBe("take");
	});

	// A second `buncargo dev` in the same checkout reuses the servers the first
	// one started, so it is not competing for the hostname. Throwing here left
	// that run printing localhost:port URLs while the named ones worked.
	it("leaves the live owner in place for a second run of the same checkout", () => {
		expect(classifyRouteClaim(base, { ...base, pid: 200 })).toBe("keep");
	});

	it("hands the route to a run that took over its server", () => {
		expect(
			classifyRouteClaim(base, { ...base, pid: 200 }, { takeover: true }),
		).toBe("take");
	});

	// Same checkout but a different port is a real disagreement: one of the two
	// would be advertising a hostname pointing at the other's server.
	it("refuses the same checkout pointing the hostname elsewhere", () => {
		expect(classifyRouteClaim(base, { ...base, pid: 200, port: 3999 })).toBe(
			"conflict",
		);
	});

	it("keeps a static service route registered twice", () => {
		const staticRoute: HostsRoute = {
			hostname: "mailpit.serpier.localhost",
			port: 8025,
			kind: "service",
			name: "mailpit",
			root: "/repo",
		};
		expect(classifyRouteClaim(staticRoute, { ...staticRoute })).toBe("take");
	});
});

/**
 * One registry is shared by every `buncargo dev` on the machine. Before these
 * paths were locked, eight simultaneous registrations left a single route on
 * disk: each writer merged into a snapshot taken before its peers wrote.
 */
describe("concurrent registration", () => {
	function routeFor(index: number): HostsRoute {
		return {
			hostname: `app.proj${index}.localhost`,
			port: 3000 + index,
			kind: "app",
			name: "web",
			root: `/repo${index}`,
			pid: process.pid,
		};
	}

	it("keeps every route when registrations overlap", async () => {
		await tempRegistry();
		const routes = Array.from({ length: 8 }, (_, i) => routeFor(i));
		await Promise.all(
			routes.map((route) =>
				upsertHostRoutes([route], { owners: pidRouteOwners }),
			),
		);

		const saved = await loadHostRoutes();
		expect(saved.map((route) => route.hostname).sort()).toEqual(
			routes.map((route) => route.hostname).sort(),
		);
	});

	// Static (pid-less) routes, so the assertion measures only the lock: a child
	// that registered with its own pid would be pruned as soon as it exited.
	it("keeps every route when separate processes register at once", async () => {
		const { dir } = await tempRegistry();
		const modulePath = join(import.meta.dir, "registry.ts");
		const script = `
			const { pidRouteOwners, upsertHostRoutes } = await import(${JSON.stringify(modulePath)});
			const index = Number(process.env.ROUTE_INDEX);
			await upsertHostRoutes(
				[{
					hostname: \`mailpit.proj\${index}.localhost\`,
					port: 8025 + index,
					kind: "service",
					name: "mailpit",
					root: process.env.ROUTES_ROOT,
				}],
				{ owners: pidRouteOwners },
			);
		`;

		const exits = await Promise.all(
			Array.from(
				{ length: 6 },
				(_, index) =>
					Bun.spawn(["bun", "-e", script], {
						env: {
							...process.env,
							ROUTE_INDEX: String(index),
							// A real directory: a static route whose checkout is
							// gone is pruned, which would hide the lock this
							// test is measuring.
							ROUTES_ROOT: dir,
						},
						stdout: "ignore",
						stderr: "pipe",
					}).exited,
			),
		);
		expect(exits).toEqual([0, 0, 0, 0, 0, 0]);

		const saved = await loadHostRoutes();
		expect(saved).toHaveLength(6);
	});
});

describe("registry writers", () => {
	const route = (overrides: Partial<AppHostsRoute> = {}): AppHostsRoute => ({
		hostname: "web.demo.localhost",
		port: 3000,
		kind: "app",
		name: "web",
		root: "/repo",
		pid: process.pid,
		...overrides,
	});
	const serviceRoute = (root = "/repo"): HostsRoute => ({
		hostname: "mail.demo.localhost",
		port: 8025,
		kind: "service",
		name: "mailpit",
		root,
	});

	// Read leniently, a corrupt file came back as [] and the writer replaced
	// it with its own routes alone: every other project's named URLs gone.
	it("refuses to rewrite a registry it cannot read", async () => {
		const { path } = await tempRegistry();
		await writeFile(path, "{ not json");
		await expect(
			upsertHostRoutes([route()], { owners: pidRouteOwners }),
		).rejects.toThrow("fix or delete it");
		await expect(removeHostRoutes(() => true)).rejects.toThrow(
			"fix or delete it",
		);
		expect(await readFile(path, "utf-8")).toBe("{ not json");
	});

	it("clears an unreadable registry on uninstall, keeping a recovery copy", async () => {
		const { path } = await tempRegistry();
		await writeFile(path, "{ not json");
		await clearHostRoutes();
		expect(await loadHostRoutes()).toEqual([]);
		expect(
			(await readdir(dirname(path))).some((name) =>
				name.includes(".recovery-"),
			),
		).toBe(true);
	});

	// After a reboot the pid belongs to some other process: the route held
	// its hostname against the next run of the checkout.
	it("takes a hostname whose owner's pid now belongs to another process", async () => {
		await tempRegistry();
		await upsertHostRoutes(
			[route({ pid: process.ppid, processIdentity: "v2:a-dead-run" })],
			{ owners: pidRouteOwners },
		);
		await upsertHostRoutes([route({ port: 4000 })], {
			owners: identityRouteOwners,
		});
		expect(await loadHostRoutes()).toMatchObject([
			{ hostname: "web.demo.localhost", port: 4000, pid: process.pid },
		]);
	});

	it("still refuses a live owner whose identity matches", async () => {
		await tempRegistry();
		await upsertHostRoutes(
			[
				route({
					pid: process.pid,
					processIdentity: readCurrentProcessIdentity(),
					root: "/other",
				}),
			],
			{ owners: pidRouteOwners },
		);
		const conflicts = await upsertHostRoutes([route({ pid: process.ppid })], {
			owners: identityRouteOwners,
		});
		expect(conflicts).toMatchObject([{ ownerRoot: "/other" }]);
		expect(await loadHostRoutes()).toMatchObject([{ root: "/other" }]);
	});

	it("records the owner's identity with an app route", () => {
		const [app] = routesFromPlan(
			[
				{
					kind: "app",
					name: "web",
					hostname: "web.demo.localhost",
					baseHostname: "web.demo.localhost",
					targetPort: 3000,
				},
			],
			{ root: "/repo", pid: process.pid, processIdentity: "v2:abc" },
		);
		expect(app).toMatchObject({ processIdentity: "v2:abc" });
	});

	// `dev --down` stops this checkout's containers. Another live run of the
	// checkout still serves its apps, and removing every route 404'd them.
	it("takes only the checkout's service routes down with dev --down", () => {
		const removes = routesDownRemoves("/repo");
		expect(removes(serviceRoute())).toBe(true);
		expect(removes(route())).toBe(false);
		expect(removes(serviceRoute("/other"))).toBe(false);
	});
});

describe("liveNamedHosts", () => {
	const web = {
		kind: "app" as const,
		name: "web",
		hostname: "web.demo.localhost",
		baseHostname: "web.demo.localhost",
		targetPort: 3000,
	};
	const plan = [web];
	const registered = (
		overrides: Partial<AppHostsRoute> = {},
	): AppHostsRoute => ({
		hostname: "web.demo.localhost",
		port: 3000,
		kind: "app",
		name: "web",
		root: "/repo",
		pid: 10,
		...overrides,
	});
	const ownerAlive = (alive: number[]) => (route: AppHostsRoute) =>
		alive.includes(route.pid);
	const live = (routes: HostsRoute[], alive = [10]) =>
		liveNamedHosts({
			root: "/repo",
			plan,
			routes,
			ownerAlive: ownerAlive(alive),
		}).length > 0;

	it("is live while a running owner registered the hostname for this checkout", () => {
		expect(live([registered()])).toBe(true);
	});

	// A plan alone handed a vite.config https URLs while the run was on
	// localhost:port, or with no run at all.
	it("is not live from the plan alone", () => {
		expect(live([])).toBe(false);
		expect(live([registered()], [])).toBe(false);
		expect(live([registered({ port: 4000 })])).toBe(false);
		expect(live([registered({ root: "/other" })])).toBe(false);
	});

	// A takeover that ended removed api's route; web's was still served and
	// getEnvVar handed web localhost all the same.
	it("answers per entry, so one missing route leaves the others named", () => {
		const api = {
			...web,
			name: "api",
			hostname: "api.demo.localhost",
			baseHostname: "api.demo.localhost",
			targetPort: 4000,
		};
		const result = liveNamedHosts({
			root: "/repo",
			plan: [web, api],
			routes: [registered()],
			ownerAlive: ownerAlive([10]),
		});
		expect(result.map((entry) => entry.name)).toEqual(["web"]);
	});
});

describe("routesAfterWithdraw", () => {
	const at = (overrides: Partial<AppHostsRoute>): AppHostsRoute => ({
		hostname: "web.demo.localhost",
		port: 3000,
		kind: "app",
		name: "web",
		root: "/repo",
		pid: process.pid,
		...overrides,
	});
	const own = at({});
	const service: HostsRoute = {
		hostname: "mail.demo.localhost",
		port: 3000,
		kind: "service",
		name: "web",
		root: "/repo",
	};
	const elsewhere = at({ root: "/other" });

	// Left behind, a fallen-back run's routes read as live named URLs to
	// `env` and `getEnvVar` while the run printed localhost:port.
	it("takes out the run's own routes and its checkout's service routes", () => {
		expect(
			routesAfterWithdraw([own, service, elsewhere], {
				root: "/repo",
				pid: process.pid,
			}),
		).toEqual([elsewhere]);
	});

	it("leaves the service routes to another live run of the checkout", () => {
		const other = at({ hostname: "api.demo.localhost", pid: process.ppid });
		expect(
			routesAfterWithdraw([own, service, other], {
				root: "/repo",
				pid: process.pid,
			}),
		).toEqual([service, other]);
	});
});
