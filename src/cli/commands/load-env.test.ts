import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execAsync } from "../../core/process";
import {
	buildRunEntry,
	publishRun,
	type RunEntry,
	readLiveRuns,
} from "../../core/run-registry";
import { freePorts, useTempHome } from "../../core/test-env.testing";
import { createDevEnvironment, internalsOf } from "../../environment";
import {
	collectActiveRunPorts,
	loadCommandEnv,
	selectActiveRunProfile,
} from "./load-env";

const CLI = resolve(import.meta.dir, "../bin.ts");
const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

function makeFixture(): string {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "buncargo-profile-cmd-")),
	);
	tempDirs.push(root);
	mkdirSync(join(root, "apps/core"), { recursive: true });
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ workspaces: ["apps/*"] }),
	);
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default {
			projectPrefix: "kanpla",
			services: {},
			apps: {
				core: {
					port: 8080,
					devCommand: false,
					cwd: "apps/core",
				},
			},
			env: (_ports, _urls, ctx) => ({
				BB_CORE_URL: "https://cloud.kanpla.example",
				CORE_DIRECT: ctx.loopbackUrls.core,
			}),
			profiles: {
				default: {
					env: { PROFILE_NAME: "default" },
				},
				local: {
					env: (_ports, _urls, ctx) => ({
						PROFILE_NAME: "local",
						BB_CORE_URL: ctx.loopbackUrls.core,
					}),
				},
				cloud: {
					env: {
						PROFILE_NAME: "cloud",
						BB_CORE_URL: "https://cloud.kanpla.example",
					},
				},
			},
			tasks: {
				"gen:bb": {
					command: 'printf "%s|%s|%s" "$PROFILE_NAME" "$BB_CORE_URL" "$CORE_PORT"',
				},
			},
		};`,
	);
	return root;
}

function runCli(root: string, ...args: string[]) {
	return execAsync(
		[process.execPath, CLI, ...args],
		root,
		{ CI: "false", GITHUB_ACTIONS: "false" },
		{ throwOnError: false },
	);
}

afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("selectActiveRunProfile & collectActiveRunPorts", () => {
	it("selects the newest non-suffixed live run profile and merges live ports", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-sel-")));
		tempDirs.push(root);
		const other = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-other-")));
		tempDirs.push(other);

		const runs: RunEntry[] = [
			{
				...buildRunEntry({
					sessionId: "old",
					projectPrefix: "app",
					projectName: "app",
					root,
					isWorktree: false,
					profile: "default",
				}),
				startedAt: "2026-01-01T09:00:00.000Z",
				services: [{ name: "postgres", status: "ready", port: 5500 }],
				apps: [{ name: "core", status: "ready", port: 8100 }],
			},
			{
				...buildRunEntry({
					sessionId: "ci",
					projectPrefix: "app",
					projectName: "app-ci-1",
					suffix: "ci-1",
					root,
					isWorktree: false,
					profile: "ci",
				}),
				startedAt: "2026-01-01T12:00:00.000Z",
				services: [{ name: "postgres", status: "ready", port: 5999 }],
				apps: [{ name: "core", status: "ready", port: 8999 }],
			},
			{
				...buildRunEntry({
					sessionId: "newest",
					projectPrefix: "app",
					projectName: "app",
					root,
					isWorktree: false,
					profile: "local",
				}),
				startedAt: "2026-01-01T10:00:00.000Z",
				apps: [
					{ name: "core", status: "ready", port: 8250 },
					{ name: "stoppedApp", status: "stopped", port: 8251 },
				],
			},
			{
				...buildRunEntry({
					sessionId: "other-checkout",
					projectPrefix: "app",
					projectName: "app-other",
					root: other,
					isWorktree: true,
					profile: "cloud",
				}),
				startedAt: "2026-01-01T11:00:00.000Z",
				apps: [{ name: "core", status: "ready", port: 8888 }],
			},
		];

		expect(selectActiveRunProfile(runs, root)).toBe("local");
		expect(collectActiveRunPorts(runs, root)).toEqual({
			postgres: 5500,
			core: 8250,
		});
	});
});

describe("active-run profile and live URL inheritance for run, exec, and env", () => {
	useTempHome();

	it("records the active profile on RunEntry when apps are claimed", async () => {
		const root = realpathSync(
			mkdtempSync(join(tmpdir(), "buncargo-claim-prof-")),
		);
		tempDirs.push(root);
		const [apiPort] = freePorts(1);
		const env = createDevEnvironment(
			{
				projectPrefix: "profrec",
				services: {},
				apps: {
					api: { port: apiPort, devCommand: "echo hi" },
				},
				profiles: { local: { env: { FOO: "bar" } } },
			},
			{ root, profile: "local" },
		);
		cleanups.push(() => env.stop().catch(() => {}));

		const internals = internalsOf(env);
		const prepared = await internals.prepare({
			watchdog: false,
			verbose: false,
		});
		await internals.claimApps(prepared, {});
		const live = await readLiveRuns();
		const mine = live.find((run) => run.sessionId === env.sessionId);
		expect(mine?.profile).toBe("local");
	});

	it("inherits active run profile and live port in run, exec, and env unless --profile overrides it", async () => {
		const root = makeFixture();
		const [livePort] = freePorts(1);

		await publishRun({
			...buildRunEntry({
				sessionId: "live-local-session",
				projectPrefix: "kanpla",
				projectName: "kanpla",
				root,
				isWorktree: false,
				profile: "local",
			}),
			apps: [
				{
					name: "core",
					status: "ready",
					port: livePort,
					url: `http://localhost:${livePort}`,
					loopbackUrl: `http://localhost:${livePort}`,
				},
			],
		});

		// `buncargo run` without --profile inherits `local` profile and the live port/URL.
		const inheritedRun = await runCli(root, "run", "gen:bb");
		expect(inheritedRun.exitCode).toBe(0);
		expect(inheritedRun.stdout).toBe(
			`local|http://localhost:${livePort}|${livePort}`,
		);

		// `buncargo exec` without --profile inherits `local` profile and the live port/URL.
		const inheritedExec = await runCli(
			root,
			"exec",
			"--",
			process.execPath,
			"-e",
			'process.stdout.write([process.env.PROFILE_NAME, process.env.BB_CORE_URL, process.env.CORE_PORT].join("|"))',
		);
		expect(inheritedExec.exitCode).toBe(0);
		expect(inheritedExec.stdout).toBe(
			`local|http://localhost:${livePort}|${livePort}`,
		);

		// `buncargo env --get` inherits the active run's profile and live URL too.
		const inheritedEnv = await runCli(root, "env", "--get", "BB_CORE_URL");
		expect(inheritedEnv.exitCode).toBe(0);
		expect(inheritedEnv.stdout.trim()).toBe(`http://localhost:${livePort}`);

		// Explicit --profile overrides the active run's profile on both run and exec.
		const overrideRun = await runCli(root, "run", "--profile=cloud", "gen:bb");
		expect(overrideRun.exitCode).toBe(0);
		expect(overrideRun.stdout).toBe(
			`cloud|https://cloud.kanpla.example|${livePort}`,
		);

		const overrideExec = await runCli(
			root,
			"exec",
			"--profile=cloud",
			"--",
			process.execPath,
			"-e",
			'process.stdout.write([process.env.PROFILE_NAME, process.env.BB_CORE_URL].join("|"))',
		);
		expect(overrideExec.exitCode).toBe(0);
		expect(overrideExec.stdout).toBe("cloud|https://cloud.kanpla.example");

		// Explicit unknown --profile still errors.
		const badProfile = await runCli(root, "run", "--profile=typo", "gen:bb");
		expect(badProfile.exitCode).toBe(1);
		expect(badProfile.stderr).toContain('Unknown profile "typo"');
	});

	it("falls back cleanly when the active run recorded a profile removed from dev.config.ts", async () => {
		const root = makeFixture();
		const [livePort] = freePorts(1);
		await publishRun({
			...buildRunEntry({
				sessionId: "stale-profile-session",
				projectPrefix: "kanpla",
				projectName: "kanpla",
				root,
				isWorktree: false,
				profile: "removed-profile",
			}),
			apps: [
				{
					name: "core",
					status: "ready",
					port: livePort,
					url: `http://localhost:${livePort}`,
					loopbackUrl: `http://localhost:${livePort}`,
				},
			],
		});

		const env = await loadCommandEnv({ cwd: root });
		const vars = env.buildEnvVars() as Record<string, string>;
		expect(vars.PROFILE_NAME).toBe("default");
		expect(vars.CORE_PORT).toBe(String(livePort));
		if (livePort >= 8080) {
			expect(env.portOffset).toBe(livePort - 8080);
		}
	});
});
