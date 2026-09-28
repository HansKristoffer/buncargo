import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverApps, isDiscoveredApp } from "./discover-apps";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function repo(workspaces: Record<string, Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), "buncargo-discover-"));
	roots.push(root);
	for (const [dir, scripts] of Object.entries(workspaces)) {
		mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, dir, "package.json"), JSON.stringify({ scripts }));
	}
	return root;
}

describe("discoverApps", () => {
	it("makes a worker per workspace that has the script, with its prebuild", () => {
		const root = repo({
			"apps/extension-admin": {
				dev: "vite build --watch",
				build: "vite build",
			},
			"extensions/theme": { dev: "x" },
			"extensions/docs": { build: "x" },
			"apps/platform": { dev: "vite" },
		});
		const apps = discoverApps({
			root,
			globs: ["apps/extension-*", "extensions/*"],
			prebuild: "build",
		});
		expect(Object.keys(apps)).toEqual(["extension-admin", "theme"]);
		expect(apps["extension-admin"]).toMatchObject({
			kind: "worker",
			devCommand: "bun run dev",
			cwd: "apps/extension-admin",
			prebuild: "bun run build",
			buildCommand: "bun run build",
		});
		// No build script: no prebuild to run.
		expect(apps.theme).not.toHaveProperty("prebuild");
		expect(isDiscoveredApp(apps.theme)).toBe(true);
		// The marker survives the spreads a config goes through.
		expect(isDiscoveredApp({ ...apps.theme } as never)).toBe(true);
	});

	it("gives servers consecutive ports", () => {
		const root = repo({ "svc/a": { dev: "x" }, "svc/b": { dev: "x" } });
		const apps = discoverApps({
			root,
			globs: ["svc/*"],
			kind: "server",
			port: 4000,
		});
		expect(
			Object.values(apps).map((app) => ("port" in app ? app.port : 0)),
		).toEqual([4000, 4001]);
	});

	it("refuses two workspaces that would share an app name", () => {
		const root = repo({ "a/theme": { dev: "x" }, "b/theme": { dev: "x" } });
		expect(() => discoverApps({ root, globs: ["a/*", "b/*"] })).toThrow(
			'a/theme and b/theme both become app "theme"',
		);
	});
});
