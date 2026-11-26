import { afterEach, describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunEntry, publishRun, type RunEntry } from "./run-registry";
import {
	lookupRunningApp,
	lookupRunningService,
	resolveRunningEndpoint,
} from "./sibling-lookup";
import { useTempHome } from "./test-env.testing";

const tempDirs: string[] = [];

function makeDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function makeGitCheckout(prefix: string, branch: string): string {
	const dir = makeDir(prefix);
	mkdirSync(join(dir, ".git"), { recursive: true });
	writeFileSync(join(dir, ".git/HEAD"), `ref: refs/heads/${branch}\n`);
	return dir;
}

function makeRun(
	overrides: Partial<RunEntry> & {
		sessionId: string;
		root: string;
		projectPrefix?: string;
		projectName?: string;
	},
): RunEntry {
	const projectPrefix = overrides.projectPrefix ?? "kanpla-backend";
	const projectName = overrides.projectName ?? projectPrefix;
	return {
		...buildRunEntry({
			sessionId: overrides.sessionId,
			projectPrefix,
			projectName,
			suffix: overrides.suffix,
			profile: overrides.profile,
			root: overrides.root,
			isWorktree:
				overrides.worktree !== undefined && overrides.worktree !== null,
		}),
		pid: overrides.pid ?? process.pid,
		worktree: overrides.worktree ?? null,
		branch: overrides.branch,
		startedAt: overrides.startedAt ?? "2026-01-01T10:00:00.000Z",
		updatedAt: overrides.updatedAt ?? "2026-01-01T10:00:00.000Z",
		lifecycle: overrides.lifecycle ?? { state: "live" },
		hold: overrides.hold ?? { kind: "checkout" },
		services: overrides.services ?? [],
		apps: overrides.apps ?? [],
	};
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveRunningEndpoint", () => {
	it("resolves live sibling app and service endpoints with metadata", () => {
		const backendRoot = makeDir("buncargo-sibling-backend-");
		const runs: RunEntry[] = [
			makeRun({
				sessionId: "s-1",
				root: backendRoot,
				branch: "main",
				profile: "local",
				services: [
					{
						name: "postgres",
						status: "ready",
						port: 5532,
						url: "postgres://postgres:postgres@localhost:5532/app",
						loopbackUrl: "postgres://postgres:postgres@localhost:5532/app",
					},
				],
				apps: [
					{
						name: "core",
						status: "ready",
						port: 8180,
						url: "https://core.kanpla-backend.localhost",
						loopbackUrl: "http://localhost:8180",
						publicUrl: "https://core.trycloudflare.com",
					},
				],
			}),
		];

		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				env: {},
			}),
		).toEqual({
			name: "core",
			kind: "app",
			projectPrefix: "kanpla-backend",
			projectName: "kanpla-backend",
			root: backendRoot,
			worktree: null,
			branch: "main",
			profile: "local",
			port: 8180,
			url: "https://core.kanpla-backend.localhost",
			loopbackUrl: "http://localhost:8180",
			publicUrl: "https://core.trycloudflare.com",
			status: "ready",
		});

		expect(
			resolveRunningEndpoint("service", "kanpla-backend", "postgres", {
				runs,
				env: {},
			}),
		).toEqual({
			name: "postgres",
			kind: "service",
			projectPrefix: "kanpla-backend",
			projectName: "kanpla-backend",
			root: backendRoot,
			worktree: null,
			branch: "main",
			profile: "local",
			port: 5532,
			url: "postgres://postgres:postgres@localhost:5532/app",
			loopbackUrl: "postgres://postgres:postgres@localhost:5532/app",
			status: "ready",
		});
	});

	it("returns undefined cleanly when sibling is stopped, starting, problematic, or suffixed", () => {
		const root = makeDir("buncargo-sibling-states-");
		const runs: RunEntry[] = [
			makeRun({
				sessionId: "s-ci",
				root,
				suffix: "ci-1",
				apps: [
					{
						name: "core",
						status: "ready",
						port: 8180,
						url: "http://localhost:8180",
						loopbackUrl: "http://localhost:8180",
					},
				],
			}),
			makeRun({
				sessionId: "s-dev",
				root,
				services: [
					{
						name: "postgres",
						status: "ready",
						port: 5532,
						url: "postgres://localhost:5532/app",
						loopbackUrl: "postgres://localhost:5532/app",
						problem: {
							state: "stopped",
							detail: "container exited",
							since: "2026-01-01T10:00:00.000Z",
						},
					},
				],
				apps: [
					{
						name: "core",
						status: "starting",
						port: 8180,
						url: "http://localhost:8180",
						loopbackUrl: "http://localhost:8180",
					},
					{
						name: "down",
						status: "stopped",
						port: 8181,
						url: "http://localhost:8181",
						loopbackUrl: "http://localhost:8181",
					},
				],
			}),
		];

		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "missing", {
				runs,
				env: {},
			}),
		).toBeUndefined();
		expect(
			resolveRunningEndpoint("app", "other-project", "core", { runs, env: {} }),
		).toBeUndefined();
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "down", {
				runs,
				env: {},
			}),
		).toBeUndefined();
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				env: {},
			}),
		).toBeUndefined();
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				readyOnly: false,
				env: {},
			})?.port,
		).toBe(8180);
		expect(
			resolveRunningEndpoint("service", "kanpla-backend", "postgres", {
				runs,
				env: {},
			}),
		).toBeUndefined();
	});

	it("prefers matching Git branch (including from nested subdirectories), then newest startedAt", () => {
		const monoCheckout = makeGitCheckout("buncargo-mono-", "feat/billing");
		const nestedSubdir = join(monoCheckout, "apps/web/src");
		mkdirSync(nestedSubdir, { recursive: true });
		const mainBackend = makeDir("buncargo-backend-main-");
		const featBackend = makeDir("buncargo-backend-feat-");

		const runs: RunEntry[] = [
			makeRun({
				sessionId: "s-feat",
				root: featBackend,
				projectName: "kanpla-backend-feat",
				worktree: "feat",
				branch: "feat/billing",
				startedAt: "2026-01-01T09:00:00.000Z",
				apps: [
					{
						name: "core",
						status: "ready",
						port: 8280,
						url: "http://localhost:8280",
						loopbackUrl: "http://localhost:8280",
					},
				],
			}),
			makeRun({
				sessionId: "s-main",
				root: mainBackend,
				projectName: "kanpla-backend",
				worktree: null,
				branch: "main",
				startedAt: "2026-01-01T11:00:00.000Z",
				apps: [
					{
						name: "core",
						status: "ready",
						port: 8080,
						url: "http://localhost:8080",
						loopbackUrl: "http://localhost:8080",
					},
				],
			}),
		];

		// Auto-detected branch from root AND from a nested workspace subdir both prefer feat/billing.
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				cwd: monoCheckout,
				env: {},
			})?.port,
		).toBe(8280);
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				cwd: nestedSubdir,
				env: {},
			})?.port,
		).toBe(8280);

		// Explicit branch: false disables branch preference -> newest startedAt (main) wins.
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				cwd: monoCheckout,
				branch: false,
				env: {},
			})?.port,
		).toBe(8080);

		// Unmatched branch falls back deterministically to newest startedAt.
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				branch: "feat/unrelated",
				env: {},
			})?.port,
		).toBe(8080);
	});

	it("supports BUNCARGO_LINK_<PREFIX>, overrideEnvVar, worktree, root, and excludeRoot", () => {
		const wtA = makeDir("buncargo-wt-a-");
		const wtB = makeDir("buncargo-wt-b-");
		const runs: RunEntry[] = [
			makeRun({
				sessionId: "s-a",
				root: wtA,
				projectName: "kanpla-backend-a",
				worktree: "wt-a",
				branch: "branch-a",
				startedAt: "2026-01-01T10:00:00.000Z",
				apps: [
					{
						name: "core",
						status: "ready",
						port: 8100,
						url: "http://localhost:8100",
						loopbackUrl: "http://localhost:8100",
					},
				],
			}),
			makeRun({
				sessionId: "s-b",
				root: wtB,
				projectName: "kanpla-backend-b",
				worktree: "wt-b",
				branch: "branch-b",
				startedAt: "2026-01-01T11:00:00.000Z",
				apps: [
					{
						name: "core",
						status: "ready",
						port: 8200,
						url: "http://localhost:8200",
						loopbackUrl: "http://localhost:8200",
					},
				],
			}),
		];

		// Built-in BUNCARGO_LINK_<PROJECT_PREFIX> override pins by worktree/branch/path.
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				env: { BUNCARGO_LINK_KANPLA_BACKEND: "wt-a" },
			})?.port,
		).toBe(8100);

		// Custom overrideEnvVar pins by path and returns undefined when unmatched.
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				overrideEnvVar: "CUSTOM_BACKEND",
				env: { CUSTOM_BACKEND: wtA },
			})?.port,
		).toBe(8100);
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				overrideEnvVar: "CUSTOM_BACKEND",
				env: { CUSTOM_BACKEND: "does-not-exist" },
			}),
		).toBeUndefined();

		// Explicit worktree, root, and excludeRoot filters.
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				worktree: "wt-a",
				env: {},
			})?.port,
		).toBe(8100);
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				root: wtA,
				env: {},
			})?.port,
		).toBe(8100);
		expect(
			resolveRunningEndpoint("app", "kanpla-backend", "core", {
				runs,
				excludeRoot: wtB,
				env: {},
			})?.port,
		).toBe(8100);
	});
});

describe("lookupRunningApp & lookupRunningService with ~/.buncargo/runs.json", () => {
	useTempHome();

	it("merges multi-session checkouts and reads directly from ~/.buncargo/runs.json", async () => {
		const backendRoot = makeDir("buncargo-live-backend-");
		await publishRun({
			...buildRunEntry({
				sessionId: "sess-services",
				projectPrefix: "kanpla-backend",
				projectName: "kanpla-backend",
				root: backendRoot,
				isWorktree: false,
				profile: "local",
			}),
			services: [
				{
					name: "postgres",
					status: "ready",
					port: 5544,
					url: "postgres://localhost:5544/kanpla",
					loopbackUrl: "postgres://localhost:5544/kanpla",
				},
			],
		});
		await publishRun({
			...buildRunEntry({
				sessionId: "sess-apps",
				projectPrefix: "kanpla-backend",
				projectName: "kanpla-backend",
				root: backendRoot,
				isWorktree: false,
				profile: "local",
			}),
			apps: [
				{
					name: "core",
					status: "ready",
					port: 8456,
					url: "https://core.kanpla-backend.localhost",
					loopbackUrl: "http://localhost:8456",
				},
			],
		});

		const app = lookupRunningApp("kanpla-backend", "core");
		const svc = lookupRunningService("kanpla-backend", "postgres");
		expect(app?.loopbackUrl).toBe("http://localhost:8456");
		expect(app?.profile).toBe("local");
		expect(svc?.port).toBe(5544);
	});
});
