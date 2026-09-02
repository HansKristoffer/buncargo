import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyRouteClaim,
	type HostsRoute,
	HostsRouteConflictError,
	loadHostRoutes,
	pruneHostRoutes,
	removeHostRoutes,
	upsertHostRoutes,
} from "./registry";

async function tempRegistry(): Promise<{ path: string; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "buncargo-hosts-"));
	return { dir, path: join(dir, "routes.json") };
}

afterEach(async () => {
	// temp dirs cleaned per test
});

describe("hosts registry", () => {
	it("upserts routes and loads them back", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "api.serpier.localhost",
						port: 3000,
						kind: "app",
						name: "api",
						root: "/repo",
						pid: process.pid,
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			const routes = await loadHostRoutes(path);
			expect(routes).toHaveLength(1);
			expect(routes[0]?.hostname).toBe("api.serpier.localhost");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("takes over a route whose owner pid is dead", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "api.serpier.localhost",
						port: 3000,
						kind: "app",
						name: "api",
						root: "/old",
						pid: 99999999,
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
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
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			const routes = await loadHostRoutes(path);
			expect(routes[0]?.port).toBe(3100);
			expect(routes[0]?.root).toBe("/new");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects a live owner unless force is set", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "api.serpier.localhost",
						port: 3000,
						kind: "app",
						name: "api",
						root: "/a",
						pid: process.pid,
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			await expect(
				upsertHostRoutes(
					[
						{
							hostname: "api.serpier.localhost",
							port: 3100,
							kind: "app",
							name: "api",
							root: "/b",
							pid: process.pid,
							updatedAt: new Date().toISOString(),
						},
					],
					{ path },
				),
			).rejects.toBeInstanceOf(HostsRouteConflictError);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("prunes dead-pid routes and keeps static service routes", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "api.serpier.localhost",
						port: 3000,
						kind: "app",
						name: "api",
						root: "/repo",
						pid: 99999999,
						updatedAt: new Date().toISOString(),
					},
					{
						hostname: "mailpit.serpier.localhost",
						port: 8025,
						kind: "service",
						name: "mailpit",
						root: "/repo",
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			const pruned = await pruneHostRoutes(path, {
				// The checkout is fictional here; its existence is a separate rule.
				directoryExists: () => true,
			});
			expect(pruned.map((route) => route.hostname)).toEqual([
				"mailpit.serpier.localhost",
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// The second run must not become the owner: `releaseNamedHosts` filters by
	// pid, so the route has to disappear when the run that owns the servers
	// exits, not when the reusing run does.
	it("keeps the first run as owner when a second run registers the same route", async () => {
		const { dir, path } = await tempRegistry();
		try {
			const route: HostsRoute = {
				hostname: "api.serpier.localhost",
				port: 3000,
				kind: "app",
				name: "api",
				root: "/repo",
				pid: process.pid,
				updatedAt: new Date().toISOString(),
			};
			await upsertHostRoutes([route], { path });
			await upsertHostRoutes([{ ...route, pid: process.pid + 1 }], { path });

			const saved = await loadHostRoutes(path);
			expect(saved).toHaveLength(1);
			expect(saved[0]?.pid).toBe(process.pid);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// Nothing retires a static route on its own, so a deleted worktree would
	// keep its hostnames in the registry — and in /etc/hosts — forever.
	it("drops a static route whose checkout has been deleted", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "mailpit.serpier.localhost",
						port: 8025,
						kind: "service",
						name: "mailpit",
						root: "/repo/worktrees/gone",
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			const pruned = await pruneHostRoutes(path, {
				directoryExists: () => false,
			});
			expect(pruned).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps a static route whose checkout is still there", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "mailpit.serpier.localhost",
						port: 8025,
						kind: "service",
						name: "mailpit",
						root: dir,
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			expect(await pruneHostRoutes(path)).toHaveLength(1);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("removes routes by predicate", async () => {
		const { dir, path } = await tempRegistry();
		try {
			await upsertHostRoutes(
				[
					{
						hostname: "api.serpier.localhost",
						port: 3000,
						kind: "app",
						name: "api",
						root: "/repo",
						pid: process.pid,
						updatedAt: new Date().toISOString(),
					},
				],
				{ path },
			);
			await removeHostRoutes(
				(route) => route.root === "/repo" && route.kind === "app",
				path,
			);
			expect(await loadHostRoutes(path)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("classifyRouteClaim", () => {
	const base: HostsRoute = {
		hostname: "api.serpier.localhost",
		port: 3000,
		kind: "app",
		name: "api",
		root: "/repo",
		pid: 100,
		updatedAt: "2026-01-01T00:00:00.000Z",
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

	// Same checkout but a different port is a real disagreement: one of the two
	// would be advertising a hostname pointing at the other's server.
	it("refuses the same checkout pointing the hostname elsewhere", () => {
		expect(classifyRouteClaim(base, { ...base, pid: 200, port: 3999 })).toBe(
			"conflict",
		);
	});

	it("keeps a static service route registered twice", () => {
		const staticRoute: HostsRoute = {
			...base,
			kind: "service",
			name: "mailpit",
			pid: undefined,
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
			updatedAt: new Date().toISOString(),
		};
	}

	it("keeps every route when registrations overlap", async () => {
		const { dir, path } = await tempRegistry();
		try {
			const routes = Array.from({ length: 8 }, (_, i) => routeFor(i));
			await Promise.all(
				routes.map((route) => upsertHostRoutes([route], { path })),
			);

			const saved = await loadHostRoutes(path);
			expect(saved.map((route) => route.hostname).sort()).toEqual(
				routes.map((route) => route.hostname).sort(),
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	// Static (pid-less) routes, so the assertion measures only the lock: a child
	// that registered with its own pid would be pruned as soon as it exited.
	it("keeps every route when separate processes register at once", async () => {
		const { dir, path } = await tempRegistry();
		try {
			const modulePath = join(import.meta.dir, "registry.ts");
			const script = `
				const { upsertHostRoutes } = await import(${JSON.stringify(modulePath)});
				const index = Number(process.env.ROUTE_INDEX);
				await upsertHostRoutes(
					[{
						hostname: \`mailpit.proj\${index}.localhost\`,
						port: 8025 + index,
						kind: "service",
						name: "mailpit",
						root: process.env.ROUTES_ROOT,
						updatedAt: new Date().toISOString(),
					}],
					{ path: process.env.ROUTES_PATH },
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
								ROUTES_PATH: path,
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

			const saved = await loadHostRoutes(path);
			expect(saved).toHaveLength(6);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
