import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	DAEMON_CONFIG_FILENAME,
	ROUTES_FILENAME,
} from "../../../core/hosts/paths";
import { HEALTH_PATH } from "../../../core/hosts/proxy";
import { CI_ENV_VARS } from "../../../core/runtime-flags";
import {
	dockerListLine,
	fakeDocker,
} from "../../../docker/fake-docker.testing";
import type { StatusJson } from "../../json-documents";
import { appStatusLines, describePlannedOffset, runHealth } from "./status";

const cli = resolve(import.meta.dir, "../../bin.ts");
let dir: string;
let served: string[] = [];
let daemon: ReturnType<typeof Bun.serve>;

/**
 * A hosts daemon answering health for whatever `served` lists, on a port of
 * its own: the CLI reads the port from the isolated HOME's daemon config.
 */
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-status-")));
	daemon = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === HEALTH_PATH
				? Response.json({
						ok: true,
						routes: served.length,
						hostnames: served,
						lastReloadAt: Date.now(),
					})
				: new Response("not found", { status: 404 }),
	});
	const home = join(dir, "home");
	const configPath = join(home, ".buncargo", DAEMON_CONFIG_FILENAME);
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(
		configPath,
		JSON.stringify({ httpsPort: daemon.port, httpPort: 0, tls: false }),
	);
	writeFileSync(
		join(dir, "dev.config.ts"),
		`export default { projectPrefix: "statusjson", services: {}, apps: { web: { port: 5173, devCommand: "true" } }, options: { hosts: true } };`,
	);
});
afterEach(() => {
	daemon.stop(true);
	served = [];
	rmSync(dir, { recursive: true, force: true });
});

/** `buncargo status --json` without blocking the daemon this process serves. */
async function status(): Promise<StatusJson> {
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: join(dir, "home"),
	};
	for (const name of CI_ENV_VARS) delete env[name];
	delete env.BUNCARGO_HOSTS;
	const proc = Bun.spawn([process.execPath, cli, "status", "--json"], {
		cwd: dir,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`status exited ${code}: ${stderr}`);
	return JSON.parse(stdout) as StatusJson;
}

it("reports named hosts as the daemon serves them, with their URLs", async () => {
	const before = await status();
	// `status --json | head -40` cut the runs off when they came last. The
	// rest is StatusJson: a key may be added, never dropped.
	expect(Object.keys(before)).toEqual([
		"runs",
		"project",
		"root",
		"portOffset",
		"portOffsetProvenance",
		"composeFile",
		"runtime",
		"checkSlots",
		"ports",
		"urls",
		"containers",
		"hosts",
		"tunnels",
		"recentStops",
		"envOverrides",
		"strayLoopbackUrls",
	]);
	expect(before.hosts?.active).toBe(false);
	expect(before.urls.web).toMatch(/^http:\/\/localhost:\d+$/);

	// Served by the daemon, but no run of this checkout registered them: a
	// healthy daemon alone is not one serving this project.
	const plan = before.hosts?.plan ?? [];
	served = plan.map((entry) => entry.hostname);
	expect(served.length).toBeGreaterThan(0);
	expect((await status()).hosts?.active).toBe(false);

	// A live run (this process) registered them, as `buncargo dev` does.
	const routesPath = join(dir, "home", ".buncargo", ROUTES_FILENAME);
	writeFileSync(
		routesPath,
		JSON.stringify({
			version: 1,
			routes: plan.map((entry) => ({
				hostname: entry.hostname,
				port: entry.targetPort,
				kind: "app",
				name: "web",
				root: dir,
				pid: process.pid,
				updatedAt: new Date().toISOString(),
			})),
		}),
	);
	const after = await status();
	expect(after.hosts?.active).toBe(true);
	expect(after.urls.web).toStartWith("https://");
	expect(served.some((hostname) => after.urls.web?.includes(hostname))).toBe(
		true,
	);
}, 30_000);

it("says where the next run moves an unclaimed block, and which port forced it", () => {
	const ports = {
		postgres: { port: 6032, state: "free", owner: null },
		api: {
			port: 8600,
			state: "foreign",
			owner:
				"port 8600 held by process 74437 (bun) in /Users/x/.Trash/t3-348bb4e1/apps/backend",
		},
	};
	expect(describePlannedOffset({ offset: 5600, planned: 5600, ports })).toBe(
		undefined,
	);
	expect(describePlannedOffset({ offset: 5600, planned: 5700, ports })).toEqual(
		{
			offset: 5700,
			reason:
				"api: port 8600 held by process 74437 (bun) in /Users/x/.Trash/t3-348bb4e1/apps/backend",
		},
	);
});

it("reads a run with a service down under it as degraded", () => {
	expect(runHealth({ services: [{ name: "postgres", status: "ready" }] })).toBe(
		"ok",
	);
	expect(
		runHealth({
			services: [
				{
					name: "postgres",
					status: "ready",
					problem: {
						state: "stopped",
						detail: "postgres stopped (exit 0)",
						since: "2026-10-19T14:16:53.000Z",
					},
				},
			],
		}),
	).toBe("degraded");
});

it("starts the plain status with one aligned line per app", () => {
	expect(
		appStatusLines([
			{
				apps: [
					{
						name: "api",
						status: "ready",
						openUrl: "https://api.app.localhost",
					},
					{ name: "worker", status: "failed" },
				],
			},
		]),
	).toEqual([
		"apps:",
		"  api     ready   https://api.app.localhost",
		"  worker  failed",
	]);
	expect(appStatusLines([])).toEqual([
		"apps: no live run (start one with `buncargo dev --detach`)",
	]);
});

it("reads six ports with one lsof and one docker ps, and reports the check slots", async () => {
	const docker = fakeDocker({
		ps: {
			stdout: `${dockerListLine({
				id: "a1",
				name: "forks-postgres-1",
				ports: "127.0.0.1:15432->5432/tcp",
				project: "other",
			})}\n`,
		},
	});
	try {
		// `lsof` that lists no listener and counts its calls.
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const lsofCalls = join(dir, "lsof-calls");
		writeFileSync(
			join(bin, "lsof"),
			`#!/bin/sh\necho "$*" >> '${lsofCalls}'\nexit 1\n`,
			{ mode: 0o700 },
		);
		writeFileSync(
			join(dir, "dev.config.ts"),
			`export default {
				projectPrefix: "forks",
				docker: { runtime: "docker", binary: ${JSON.stringify(docker.binary)} },
				services: {
					postgres: { port: 15432, docker: { image: "postgres:16" } },
					redis: { port: 16379, docker: { image: "redis:7" } },
					mail: { port: 18025, docker: { image: "axllent/mailpit" } },
				},
				apps: {
					web: { port: 15173, devCommand: "true" },
					api: { port: 18080, devCommand: "true" },
					admin: { port: 15174, devCommand: "true" },
				},
			};`,
		);
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: join(dir, "home"),
			PATH: `${bin}:${process.env.PATH}`,
			// A pinned offset: the unpinned hash is checked with a probe of its own.
			BUNCARGO_PORT_OFFSET: "0",
		};
		for (const name of CI_ENV_VARS) delete env[name];
		const proc = Bun.spawn([process.execPath, cli, "status", "--json"], {
			cwd: dir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`status exited ${code}: ${stderr}`);
		const result = JSON.parse(stdout) as {
			ports: Record<string, { state: string; owner: string | null }>;
			runtime: { running: boolean };
			checkSlots: { capacity: number; enabled: boolean; holders: unknown[] };
		};

		expect(Object.keys(result.ports)).toHaveLength(6);
		expect(result.ports.postgres?.state).toBe("foreign");
		expect(result.runtime.running).toBe(true);
		expect(result.checkSlots).toMatchObject({
			capacity: 3,
			enabled: true,
			holders: [],
		});
		expect(docker.calls().map((args) => args[0])).toEqual(["ps"]);
		expect(readFileSync(lsofCalls, "utf8").trim().split("\n")).toHaveLength(1);
	} finally {
		docker.remove();
	}
}, 30_000);
