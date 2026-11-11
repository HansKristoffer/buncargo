import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	pidRouteOwners,
	routesFromPlan,
	upsertHostRoutes,
} from "../../core/hosts/registry";
import { CI_ENV_VARS } from "../../core/runtime-flags";
import { createDevEnvironment } from "../../environment";
import type { EnvJson } from "../json-documents";
import { formatEnvDotValue, formatEnvExports, getEnvDotPath } from "./env";

describe("getEnvDotPath", () => {
	const snapshot = {
		ports: { api: 3000, web: 3001 },
		urls: { api: "http://localhost:3000" },
		isWorktree: true,
	};

	it("reads nested values", () => {
		expect(getEnvDotPath(snapshot, "ports.api")).toBe(3000);
		expect(getEnvDotPath(snapshot, "urls.api")).toBe("http://localhost:3000");
		expect(getEnvDotPath(snapshot, "isWorktree")).toBe(true);
	});

	it("returns undefined for missing paths", () => {
		expect(getEnvDotPath(snapshot, "ports.missing")).toBeUndefined();
		expect(getEnvDotPath(snapshot, "ports.api.nested")).toBeUndefined();
	});
});

describe("formatEnvDotValue", () => {
	it("prints scalars raw and objects as JSON", () => {
		expect(formatEnvDotValue(3000)).toBe("3000");
		expect(formatEnvDotValue("http://localhost:3000")).toBe(
			"http://localhost:3000",
		);
		expect(formatEnvDotValue({ api: 3000 })).toBe('{"api":3000}');
	});
});

describe("formatEnvExports", () => {
	it("quotes values so a shell expands nothing", () => {
		expect(
			formatEnvExports({ DATABASE_URL: "postgres://a$b@x/db", NOTE: "it's" }),
		).toBe("export DATABASE_URL='postgres://a$b@x/db'\nexport NOTE='it'\\''s'");
	});
});

describe("buncargo env", () => {
	// During a daemon restart, or with one hostname unserved, `env`, `url`
	// and `open` printed localhost for every app while the run's apps held
	// their https URLs.
	it("prints the EnvJson document, naming each app whose route a live run serves, and only those", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-env-")));
		const config = {
			projectPrefix: "liveurls",
			services: {},
			apps: {
				api: { port: 3000, devCommand: false as const },
				web: { port: 3001, devCommand: false as const },
			},
			options: { hosts: true, worktreeIsolation: false },
		};
		writeFileSync(join(root, "package.json"), "{}");
		writeFileSync(
			join(root, "dev.config.ts"),
			`export default ${JSON.stringify(config)};`,
		);
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: join(root, "home"),
			BUNCARGO_PORT_OFFSET: "0",
		};
		for (const name of [...CI_ENV_VARS, "BUNCARGO_HOSTS"]) delete env[name];
		const saved = process.env;
		process.env = env;
		try {
			// This test process stands in for the run serving web's route.
			const plan = createDevEnvironment(config, { root }).hosts?.plan ?? [];
			await upsertHostRoutes(
				routesFromPlan(
					plan.filter((entry) => entry.name === "web"),
					{ root, pid: process.pid },
				),
				{ owners: pidRouteOwners },
			);
		} finally {
			process.env = saved;
		}

		try {
			const child = Bun.spawn(
				[process.execPath, resolve(import.meta.dir, "../bin.ts"), "env"],
				{ cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
			const document = JSON.parse(stdout) as EnvJson;
			// EnvJson is a contract scripts parse: a key may be added, never dropped.
			expect(Object.keys(document).sort()).toEqual([
				"captured",
				"details",
				"hosts",
				"isWorktree",
				"localIp",
				"loopbackUrls",
				"overrides",
				"portOffset",
				"portOffsetProvenance",
				"ports",
				"projectName",
				"root",
				"urls",
				"vars",
			]);
			const { urls } = document;
			expect(urls.web).toMatch(
				/^https:\/\/(?:[a-z0-9-]+\.)?web\.liveurls\.localhost$/,
			);
			expect(urls.api).toBe("http://localhost:3000");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
