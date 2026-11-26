import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ResolvedLinkConfig } from "../types";
import {
	applyProfileLinkOverrides,
	linkedPortsOf,
	linkStartupIssues,
	pickExportedEnv,
	readLinkPins,
	resolveLinks,
	updateLinkPins,
} from "./links";
import { findStrayLoopbackUrls } from "./loopback-env";
import { CHECKOUT_HOLD, LIVE, type RunEntry } from "./run-registry";
import { useTempHome } from "./test-env.testing";

const home = useTempHome();
const canonicalize = (path: string) => resolve(path);

function makeRun(overrides: Partial<RunEntry> & { root: string }): RunEntry {
	return {
		sessionId: crypto.randomUUID(),
		projectPrefix: "kanpla-backend",
		projectName: "kanpla-backend-main",
		worktree: null,
		pid: process.pid,
		startedAt: "2026-11-26T10:00:00.000Z",
		updatedAt: "2026-11-26T10:00:00.000Z",
		lifecycle: LIVE,
		hold: CHECKOUT_HOLD,
		hosts: null,
		cli: { program: process.execPath },
		apps: [
			{
				name: "core",
				port: 8180,
				url: "http://localhost:8180",
				loopbackUrl: "http://localhost:8180",
				status: "ready",
			},
		],
		services: [],
		...overrides,
	};
}

describe("applyProfileLinkOverrides", () => {
	const base: Record<string, ResolvedLinkConfig> = {
		backend: { project: "kanpla-backend", path: "../backend", required: false },
		kanpla: { project: "kanpla", required: true, apps: ["firebase", "api"] },
	};

	it("marks links disabled when a profile sets them to false", () => {
		const effective = applyProfileLinkOverrides(base, { kanpla: false });
		expect(effective?.kanpla.disabled).toBe(true);
		expect(effective?.backend.disabled).toBeUndefined();
	});

	it("overrides required, apps and services without losing project or path", () => {
		const effective = applyProfileLinkOverrides(base, {
			backend: { required: true, apps: ["core", "emails"] },
		});
		expect(effective?.backend).toEqual({
			project: "kanpla-backend",
			path: "../backend",
			disabled: false,
			required: true,
			apps: ["core", "emails"],
		});
	});
});

describe("resolveLinks", () => {
	it("auto-discovers a single live checkout matching projectPrefix and excludes self", () => {
		const selfRun = makeRun({
			root: "/code/kanpla",
			projectPrefix: "kanpla",
			projectName: "kanpla-main",
		});
		const backendRun = makeRun({
			root: "/code/backend",
			branch: "main",
			exports: { BACKEND_MODE: "local" },
		});

		const result = resolveLinks({
			root: "/code/kanpla",
			links: {
				backend: { project: "kanpla-backend", path: "../backend" },
				selfCheck: { project: "kanpla" },
			},
			pins: {},
			liveRuns: [selfRun, backendRun],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.links.backend?.root).toBe("/code/backend");
		expect(result.links.backend?.urls.core).toBe("http://localhost:8180");
		expect(result.links.backend?.ports.core).toBe(8180);
		expect(result.links.backend?.env).toEqual({ BACKEND_MODE: "local" });
		expect(result.links.backend?.branch).toBe("main");
		expect(result.inspections[0]).toMatchObject({
			name: "backend",
			status: "linked",
			source: "auto",
		});
		// A repo never links to itself.
		expect(result.links.selfCheck).toBeUndefined();
		expect(result.inspections[1]?.status).toBe("not-running");
	});

	it("merges multiple live sessions of the same checkout root, newest winning", () => {
		const older = makeRun({
			root: "/code/kanpla",
			projectPrefix: "kanpla",
			projectName: "kanpla-main",
			startedAt: "2026-11-26T09:00:00.000Z",
			apps: [
				{
					name: "firebase",
					port: 4002,
					url: "http://localhost:4002",
					loopbackUrl: "http://localhost:4002",
					status: "ready",
				},
			],
			exports: {
				FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
				GCLOUD_PROJECT: "demo-kanpla",
			},
		});
		const newer = makeRun({
			root: "/code/kanpla",
			projectPrefix: "kanpla",
			projectName: "kanpla-main",
			startedAt: "2026-11-26T09:05:00.000Z",
			apps: [
				{
					name: "api",
					port: 1000,
					url: "https://api.kanpla.localhost",
					loopbackUrl: "http://localhost:1000",
					status: "ready",
				},
			],
			captures: { token: "abc" },
		});

		const result = resolveLinks({
			root: "/code/backend",
			links: {
				kanpla: { project: "kanpla", apps: ["firebase", "api"] },
			},
			pins: {},
			liveRuns: [newer, older],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.inspections[0]?.status).toBe("linked");
		expect(result.links.kanpla?.ports).toEqual({ firebase: 4002, api: 1000 });
		expect(result.links.kanpla?.urls.api).toBe("https://api.kanpla.localhost");
		expect(result.links.kanpla?.loopbackUrls.api).toBe("http://localhost:1000");
		expect(result.links.kanpla?.env).toEqual({
			FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
			GCLOUD_PROJECT: "demo-kanpla",
		});
		expect(result.links.kanpla?.captured).toEqual({ token: "abc" });
	});

	it("reports ambiguous when multiple checkouts of the project run and none is pinned", () => {
		const main = makeRun({
			root: "/code/backend",
			branch: "main",
			worktree: null,
		});
		const worktree = makeRun({
			root: "/worktrees/backend/feat-drs",
			projectName: "kanpla-backend-feat-drs",
			branch: "feat/drs",
			worktree: "feat-drs",
		});

		const result = resolveLinks({
			root: "/code/kanpla",
			links: {
				backend: { project: "kanpla-backend", path: "../backend" },
			},
			pins: {},
			liveRuns: [main, worktree],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.links.backend).toBeUndefined();
		expect(result.inspections[0]?.status).toBe("ambiguous");
		expect(result.inspections[0]?.candidates).toHaveLength(2);

		const issues = linkStartupIssues(result.inspections);
		expect(issues.errors).toEqual([]);
		expect(issues.warnings[0]).toContain("buncargo links pin backend");
	});

	it("honors an explicit pin across multiple running worktrees and never falls back when stopped", () => {
		const main = makeRun({ root: "/code/backend", branch: "main" });
		const worktree = makeRun({
			root: "/worktrees/backend/feat-drs",
			projectName: "kanpla-backend-feat-drs",
			branch: "feat/drs",
			worktree: "feat-drs",
			apps: [
				{
					name: "core",
					port: 8280,
					url: "http://localhost:8280",
					loopbackUrl: "http://localhost:8280",
					status: "ready",
				},
			],
		});

		const pinnedRunning = resolveLinks({
			root: "/worktrees/kanpla/feat-drs",
			links: { backend: { project: "kanpla-backend" } },
			pins: { backend: "/worktrees/backend/feat-drs" },
			liveRuns: [main, worktree],
			checkoutPresence: () => "present",
			canonicalize,
		});
		expect(pinnedRunning.inspections[0]?.status).toBe("linked");
		expect(pinnedRunning.inspections[0]?.source).toBe("pinned");
		expect(pinnedRunning.links.backend?.ports.core).toBe(8280);

		// When the pinned worktree stops, do NOT fall back to main!
		const pinnedStopped = resolveLinks({
			root: "/worktrees/kanpla/feat-drs",
			links: { backend: { project: "kanpla-backend", required: true } },
			pins: { backend: "/worktrees/backend/feat-drs" },
			liveRuns: [main],
			checkoutPresence: () => "present",
			canonicalize,
		});
		expect(pinnedStopped.links.backend).toBeUndefined();
		expect(pinnedStopped.inspections[0]?.status).toBe("not-running");
		expect(linkStartupIssues(pinnedStopped.inspections).errors[0]).toContain(
			"/worktrees/backend/feat-drs",
		);
	});

	it("detects missing or unhealthy declared apps and services", () => {
		const run = makeRun({
			root: "/code/backend",
			apps: [
				{
					name: "core",
					port: 8180,
					url: "http://localhost:8180",
					loopbackUrl: "http://localhost:8180",
					status: "failed",
				},
			],
			services: [
				{
					name: "postgres",
					port: 5532,
					url: "postgresql://postgres:postgres@localhost:5532/db",
					loopbackUrl: "postgresql://postgres:postgres@localhost:5532/db",
					status: "ready",
					problem: {
						state: "stopped",
						detail: "postgres stopped",
						since: "2026-11-26T10:00:00.000Z",
					},
				},
			],
		});

		const result = resolveLinks({
			root: "/code/kanpla",
			links: {
				backend: {
					project: "kanpla-backend",
					required: true,
					apps: ["core", "emails"],
					services: ["postgres"],
				},
			},
			pins: {},
			liveRuns: [run],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.inspections[0]?.status).toBe("missing-endpoints");
		expect(result.inspections[0]?.missingApps).toEqual(["core", "emails"]);
		expect(result.inspections[0]?.missingServices).toEqual(["postgres"]);
		const issues = linkStartupIssues(result.inspections);
		expect(issues.errors[0]).toContain("apps: core, emails");
		expect(issues.errors[0]).toContain("services: postgres");
	});

	it("treats starting apps and services as not yet ready with a wait hint", () => {
		const startingRun = makeRun({
			root: "/code/kanpla",
			projectPrefix: "kanpla",
			projectName: "kanpla-main",
			apps: [
				{
					name: "firebase",
					port: 4002,
					url: "http://localhost:4002",
					loopbackUrl: "http://localhost:4002",
					status: "starting",
				},
			],
			services: [
				{
					name: "postgres",
					port: 5432,
					url: "postgresql://postgres:postgres@localhost:5432/db",
					loopbackUrl: "postgresql://postgres:postgres@localhost:5432/db",
					status: "starting",
				},
			],
		});

		const result = resolveLinks({
			root: "/code/backend",
			links: {
				kanpla: {
					project: "kanpla",
					required: true,
					apps: ["firebase"],
					services: ["postgres"],
				},
			},
			pins: {},
			liveRuns: [startingRun],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.inspections[0]?.status).toBe("missing-endpoints");
		expect(result.inspections[0]?.missingApps).toEqual(["firebase"]);
		expect(result.inspections[0]?.missingServices).toEqual(["postgres"]);
		const issues = linkStartupIssues(result.inspections);
		expect(issues.errors[0]).toContain("still starting");
		expect(issues.errors[0]).toContain("buncargo wait");
	});

	it("ignores suffixed throwaway runs (buncargo ci / withSuffix)", () => {
		const realRun = makeRun({
			root: "/code/backend",
			startedAt: "2026-11-26T09:00:00.000Z",
			exports: { MODE: "dev" },
		});
		const ciRun = makeRun({
			root: "/code/backend",
			projectName: "kanpla-backend-ci-abc",
			suffix: "ci-abc",
			startedAt: "2026-11-26T09:10:00.000Z",
			apps: [
				{
					name: "core",
					port: 49123,
					url: "http://localhost:49123",
					loopbackUrl: "http://localhost:49123",
					status: "ready",
				},
			],
			exports: { MODE: "ci" },
		});

		const result = resolveLinks({
			root: "/code/kanpla",
			links: { backend: { project: "kanpla-backend" } },
			pins: {},
			liveRuns: [realRun, ciRun],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.inspections[0]?.status).toBe("linked");
		expect(result.links.backend?.ports.core).toBe(8180);
		expect(result.links.backend?.env).toEqual({ MODE: "dev" });
	});

	it("rejects pins pointing to a different project or self and handles unknown presence safely", () => {
		const otherRun = makeRun({
			root: "/code/other",
			projectPrefix: "other-project",
			projectName: "other-project-main",
		});

		const wrongProject = resolveLinks({
			root: "/code/kanpla",
			links: { backend: { project: "kanpla-backend" } },
			pins: { backend: "/code/other" },
			liveRuns: [otherRun],
			checkoutPresence: () => "present",
			canonicalize,
		});
		expect(wrongProject.links.backend).toBeUndefined();
		expect(wrongProject.inspections[0]?.status).toBe("not-running");
		expect(wrongProject.inspections[0]?.pinProjectMismatch).toBe(
			"other-project",
		);
		expect(linkStartupIssues(wrongProject.inspections).warnings[0]).toContain(
			'running "other-project"',
		);

		// Self pin is ignored even if edited manually in links.json.
		const selfRun = makeRun({
			root: "/code/kanpla",
			projectPrefix: "kanpla-backend",
			projectName: "kanpla-backend-self",
		});
		const selfPinned = resolveLinks({
			root: "/code/kanpla",
			links: { backend: { project: "kanpla-backend" } },
			pins: { backend: "/code/kanpla" },
			liveRuns: [selfRun],
			checkoutPresence: () => "present",
			canonicalize,
		});
		expect(selfPinned.links.backend).toBeUndefined();

		// `unknown` presence (e.g. EACCES) never falsely flags a pin as deleted.
		const inaccessible = resolveLinks({
			root: "/code/kanpla",
			links: { backend: { project: "kanpla-backend" } },
			pins: { backend: "/code/backend" },
			liveRuns: [],
			checkoutPresence: () => "unknown",
			canonicalize,
		});
		expect(inaccessible.inspections[0]?.pinMissing).toBe(false);
		expect(linkStartupIssues(inaccessible.inspections).warnings).toEqual([]);
	});

	it("respects profile-disabled links even while a matching repo is running", () => {
		const run = makeRun({ root: "/code/backend" });
		const result = resolveLinks({
			root: "/code/kanpla",
			links: {
				backend: { project: "kanpla-backend", required: true, disabled: true },
			},
			pins: {},
			liveRuns: [run],
			checkoutPresence: () => "present",
			canonicalize,
		});

		expect(result.links.backend).toBeUndefined();
		expect(result.inspections[0]?.status).toBe("disabled");
		expect(linkStartupIssues(result.inspections)).toEqual({
			errors: [],
			warnings: [],
		});
	});
});

describe("linkedPortsOf and stray loopback exemption", () => {
	it("collects linked app/service ports and exported emulator ports so strayLoopbackUrls ignores them", () => {
		const ports = linkedPortsOf({
			backend: {
				project: "kanpla-backend",
				projectName: "kanpla-backend-main",
				root: "/code/backend",
				worktree: null,
				ports: { core: 8180, emails: 3100 },
				urls: {
					core: "http://localhost:8180",
					emails: "http://localhost:3100",
				},
				loopbackUrls: {
					core: "http://localhost:8180",
					emails: "http://localhost:3100",
				},
				publicUrls: {},
				captured: {},
				env: {
					FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
					STORAGE_EMULATOR_HOST: "http://127.0.0.1:8100",
				},
				appStatuses: { core: "ready", emails: "ready" },
				serviceStatuses: {},
			},
		});

		expect([...ports].sort((a, b) => a - b)).toEqual([3100, 8080, 8100, 8180]);

		// In Kanpla, mono's `frontend` is on 3000 while backend's `emails` is on 3100
		// (`(3100 - 3000) % 100 === 0`): allowedPorts prevents a false positive.
		const stray = findStrayLoopbackUrls({
			sources: [
				{
					source: "the injected environment",
					values: {
						EMAIL_API_URL: "http://localhost:3100",
						STORAGE_EMULATOR_HOST: "http://127.0.0.1:8100",
					},
				},
			],
			ports: { frontend: 3000, api: 1000 },
			allowedPorts: ports,
			isListening: () => true,
		});
		expect(stray).toEqual([]);
	});
});

describe("pickExportedEnv and pin persistence", () => {
	it("exports only allow-listed keys", () => {
		expect(
			pickExportedEnv(
				{
					FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
					SECRET_API_KEY: "do-not-export",
				},
				["FIRESTORE_EMULATOR_HOST", "MISSING_KEY"],
			),
		).toEqual({ FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" });
	});

	it("persists and clears per-checkout pins in .buncargo/links.json", async () => {
		const root = realpathSync(mkdtempSync(join(home(), "links-pins-")));
		expect(readLinkPins(root)).toEqual({});

		await updateLinkPins(root, { set: { backend: "/code/backend" } });
		expect(readLinkPins(root)).toEqual({ backend: "/code/backend" });

		await updateLinkPins(root, { unset: ["backend"] });
		expect(readLinkPins(root)).toEqual({});
	});
});
