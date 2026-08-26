import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
			const pruned = await pruneHostRoutes(path);
			expect(pruned.map((route) => route.hostname)).toEqual([
				"mailpit.serpier.localhost",
			]);
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
