import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveApps, resolveServices } from "../config/resolve";
import { service } from "../docker-compose/services";
import { applyHostPlanToUrls } from "./hosts/plan";
import {
	checkoutProjectNames,
	computeDevIdentity,
	computeLoopbackUrls,
	computeUrls,
	getProjectName,
	getWorktreeProjectSuffix,
} from "./ports";
import { useTempHome } from "./test-env.testing";

const home = useTempHome();

/** A directory under the temporary HOME whose `.git` file names `worktree`'s gitdir. */
function worktreeCheckout(worktree: string, name = "checkout"): string {
	const parent = mkdtempSync(join(home(), "parent-"));
	const root = join(parent, name);
	mkdirSync(root);
	writeFileSync(
		join(root, ".git"),
		`gitdir: /tmp/repo/.git/worktrees/${worktree}`,
	);
	return root;
}

describe("computeUrls", () => {
	it("builds a preset's URL from the preset, whatever its key", () => {
		const services = {
			db: service.postgres({ database: "app" }),
			cache: service.redis(),
		};
		const urls = computeUrls(
			resolveServices(services),
			{},
			{ db: 5433, cache: 6380 },
			"",
		);
		expect(urls).toEqual({
			db: "postgresql://postgres:postgres@localhost:5433/app",
			cache: "redis://localhost:6380",
		});
	});

	const localIp = "192.168.1.100";

	it("uses the app host for apps only", () => {
		const result = computeUrls(
			resolveServices({ postgres: { port: 5432 } }),
			resolveApps({ api: { port: 3000, devCommand: "bun run dev" } }),
			{ postgres: 5432, api: 3000 },
			localIp,
			"worker.ts.net",
		);
		expect(result.api).toBe("http://worker.ts.net:3000");
		expect(result.postgres).toContain("@localhost:5432");
	});

	it.each([
		[
			"postgres",
			5432,
			"postgresql://postgres:postgres@localhost:5432/postgres",
		],
		["redis", 6379, "redis://localhost:6379"],
		["clickhouse", 8123, "http://default:clickhouse@localhost:8123/default"],
	])("builds the default %s URL from its key", (name, port, expected) => {
		const services = resolveServices({ [name]: { port } });

		const result = computeUrls(services, {}, { [name]: port }, localIp);

		expect(result[name]).toBe(expected);
	});

	it("uses custom urlTemplate when provided", () => {
		const services = resolveServices({
			postgres: {
				port: 5432,
				urlTemplate: ({ port, host }) =>
					`postgresql://custom:password@${host}:${port}/mydb`,
			},
		});
		const ports = { postgres: 5432 };

		const result = computeUrls(services, {}, ports, localIp);

		expect(result.postgres).toBe(
			"postgresql://custom:password@localhost:5432/mydb",
		);
	});

	it("passes localIp to custom urlTemplate", () => {
		const services = resolveServices({
			api: {
				port: 3000,
				urlTemplate: ({ port, localIp }) => `http://${localIp}:${port}`,
			},
		});
		const ports = { api: 3000 };

		const result = computeUrls(services, {}, ports, localIp);

		expect(result.api).toBe("http://192.168.1.100:3000");
	});

	it("passes secondaryPort to custom urlTemplate", () => {
		const services = resolveServices({
			clickhouse: {
				port: 8123,
				secondaryPort: 9000,
				urlTemplate: ({ port, secondaryPort }) =>
					`http://localhost:${port}|native:${secondaryPort}`,
			},
		});
		const ports = { clickhouse: 8123, clickhouseSecondary: 9000 };

		const result = computeUrls(services, {}, ports, localIp);

		expect(result.clickhouse).toBe("http://localhost:8123|native:9000");
	});

	it("falls back to http URL for unknown services", () => {
		const services = resolveServices({
			customservice: { port: 9999 },
		});
		const ports = { customservice: 9999 };

		const result = computeUrls(services, {}, ports, localIp);

		expect(result.customservice).toBe("http://localhost:9999");
	});

	it("generates app URLs with http://localhost:port", () => {
		const services = resolveServices({
			postgres: { port: 5432 },
		});
		const apps = resolveApps({
			api: { port: 3000, devCommand: "bun run dev" },
		});
		const ports = { postgres: 5432, api: 3000 };

		const result = computeUrls(services, apps, ports, localIp);

		expect(result.api).toBe("http://localhost:3000");
	});

	it("generates appLocal URLs with local IP", () => {
		const services = resolveServices({});
		const apps = resolveApps({
			api: { port: 3000, devCommand: "bun run dev" },
			web: { port: 5173, devCommand: "bun run dev:web" },
		});
		const ports = { api: 3000, web: 5173 };

		const result = computeUrls(services, apps, ports, localIp);

		expect(result.apiLocal).toBe("http://192.168.1.100:3000");
		expect(result.webLocal).toBe("http://192.168.1.100:5173");
	});

	it("leaves named-host rewriting to applyHostPlanToUrls", () => {
		const services = resolveServices({
			postgres: { port: 5432 },
			mailpit: { port: 8025 },
		});
		const apps = resolveApps({
			api: { port: 3000, devCommand: "bun run dev" },
		});
		const ports = { postgres: 5432, mailpit: 8025, api: 3000 };

		const result = computeUrls(services, apps, ports, localIp);
		expect(result.api).toBe("http://localhost:3000");

		applyHostPlanToUrls(result, [
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				baseHostname: "api.serpier.localhost",
				targetPort: 3000,
			},
			{
				kind: "service",
				name: "mailpit",
				hostname: "mailpit.serpier.localhost",
				baseHostname: "mailpit.serpier.localhost",
				targetPort: 8025,
			},
		]);

		expect(result.api).toBe("https://api.serpier.localhost");
		expect(result.mailpit).toBe("https://mailpit.serpier.localhost");
		expect(result.apiLocal).toBe("http://192.168.1.100:3000");
		expect(result.postgres).toMatch(/^postgresql:\/\//);
	});
});

describe("computeLoopbackUrls", () => {
	const services = resolveServices({
		postgres: { port: 5432 },
		mailpit: { port: 8025 },
	});
	const apps = resolveApps({
		api: { port: 3000, devCommand: "bun run dev" },
	});
	const ports = { postgres: 5432, mailpit: 8025, api: 3000 };

	it("addresses every service and app through localhost", () => {
		const result = computeLoopbackUrls(services, apps, ports);

		expect(result.api).toBe("http://localhost:3000");
		expect(result.mailpit).toBe("http://localhost:8025");
		expect(result.postgres).toBe(
			"postgresql://postgres:postgres@localhost:5432/postgres",
		);
	});

	// The LAN IP is a different address for a different purpose (mobile
	// devices), so folding it in here would conflate the two.
	it("omits the <app>Local LAN aliases", () => {
		expect(computeLoopbackUrls(services, apps, ports)).not.toHaveProperty(
			"apiLocal",
		);
	});

	// The whole point: `applyHostPlanToUrls` rewrites the main map in place, and
	// consumers that do not trust the local CA need what it overwrote.
	it("survives a named-host rewrite of the main URL map", () => {
		const urls = computeUrls(services, apps, ports, "192.168.1.100");
		const loopback = computeLoopbackUrls(services, apps, ports);

		applyHostPlanToUrls(urls, [
			{
				kind: "app",
				name: "api",
				hostname: "api.serpier.localhost",
				baseHostname: "api.serpier.localhost",
				targetPort: 3000,
			},
		]);

		expect(urls.api).toBe("https://api.serpier.localhost");
		expect(loopback.api).toBe("http://localhost:3000");
	});
});

describe("getProjectName", () => {
	it("generates project name from prefix and directory", () => {
		expect(getProjectName("myapp", undefined, "/home/user/myproject")).toBe(
			"myapp-myproject",
		);
	});

	it("handles suffix correctly", () => {
		expect(getProjectName("myapp", "test", "/home/user/myproject")).toBe(
			"myapp-myproject-test",
		);
	});

	it.each([
		["My_Project.Name", "my-project-name"],
		["MyProject", "myproject"],
		["my-project", "my-project"],
		["my_project", "my-project"],
	])("writes the directory %s as %s", (directory, expected) => {
		expect(getProjectName("myapp", undefined, `/home/user/${directory}`)).toBe(
			`myapp-${expected}`,
		);
	});
});

describe("getWorktreeProjectSuffix", () => {
	it("returns null outside worktree", () => {
		expect(getWorktreeProjectSuffix("/tmp/does-not-exist")).toBeNull();
	});

	it("returns sanitized suffix from worktree name", () => {
		const root = worktreeCheckout("Feature_Branch.1");

		expect(getWorktreeProjectSuffix(root)).toBe("feature-branch-1");
	});
});

describe("computeDevIdentity", () => {
	it("includes worktree suffix in project name by default", () => {
		const root = worktreeCheckout("Feature_A");

		const identity = computeDevIdentity({ projectPrefix: "myapp", root });

		expect(identity.worktree).toBe(true);
		expect(identity.worktreeSuffix).toBe("feature-a");
		expect(identity.projectSuffix).toBe("feature-a");
		expect(identity.projectName).toBe(
			getProjectName("myapp", "feature-a", root),
		);
	});

	it("does not repeat a worktree name its directory already carries", () => {
		const root = worktreeCheckout("t3code-fc4fa622", "t3code-fc4fa622");

		const identity = computeDevIdentity({ projectPrefix: "gey", root });
		expect(identity.worktreeSuffix).toBe("t3code-fc4fa622");
		expect(identity.projectName).toBe("gey-t3code-fc4fa622");

		const e2e = computeDevIdentity({
			projectPrefix: "gey",
			suffix: "e2e",
			root,
		});
		expect(e2e.projectName).toBe("gey-t3code-fc4fa622-e2e");
	});

	it("omits worktree suffix when isolation is disabled", () => {
		const root = worktreeCheckout("Feature_A");

		const identity = computeDevIdentity({
			projectPrefix: "myapp",
			root,
			worktreeIsolation: false,
		});

		expect(identity.worktree).toBe(true);
		expect(identity.worktreeSuffix).toBeNull();
		expect(identity.projectSuffix).toBeUndefined();
		expect(identity.projectName).toBe(getProjectName("myapp", undefined, root));
	});

	it("composes explicit suffix with worktree suffix in stable order", () => {
		const root = worktreeCheckout("Feature_A");

		const identity = computeDevIdentity({
			projectPrefix: "myapp",
			root,
			suffix: "test",
		});

		expect(identity.projectSuffix).toBe("test-feature-a");
		expect(identity.projectName).toBe(
			getProjectName("myapp", "test-feature-a", root),
		);
	});
});

describe("checkoutProjectNames", () => {
	it("names a checkout's dev and ci stacks the way its runs do", () => {
		const worktree = worktreeCheckout("t3code-fc4fa622", "t3code-fc4fa622");
		const renamed = worktreeCheckout("Feature_A", "renamed");
		const notAWorktree = mkdtempSync(join(home(), "plain-"));

		for (const root of [worktree, renamed, notAWorktree]) {
			const names = checkoutProjectNames({ projectPrefix: "gey", root });
			expect(names).toEqual({
				dev: computeDevIdentity({ projectPrefix: "gey", root }).projectName,
				ci: computeDevIdentity({ projectPrefix: "gey", root, suffix: "ci" })
					.projectName,
			});
		}

		expect(
			checkoutProjectNames({ projectPrefix: "gey", root: renamed }),
		).toEqual({
			dev: "gey-renamed-feature-a",
			ci: "gey-renamed-ci-feature-a",
		});
	});

	it("names a deleted worktree's stacks from its worktree name", () => {
		const gone = { projectPrefix: "gey", root: "/nowhere/renamed" };
		expect(checkoutProjectNames({ ...gone, worktree: "Feature_A" })).toEqual({
			dev: "gey-renamed-feature-a",
			ci: "gey-renamed-ci-feature-a",
		});
		expect(checkoutProjectNames({ ...gone, worktree: "renamed" })).toEqual({
			dev: "gey-renamed",
			ci: "gey-renamed-ci",
		});
		expect(checkoutProjectNames({ ...gone, worktree: null })).toEqual({
			dev: "gey-renamed",
			ci: "gey-renamed-ci",
		});
		expect(
			checkoutProjectNames({
				...gone,
				worktree: "Feature_A",
				worktreeIsolation: false,
			}),
		).toEqual({ dev: "gey-renamed", ci: "gey-renamed-ci" });
	});
});
