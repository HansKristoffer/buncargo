import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedLinkConfig } from "../types";
import { watchLinks } from "./link-watch";
import { appsToRestartForLinks, linkReadyFingerprint } from "./links";
import { writeJsonDocument } from "./registry-file";
import { CHECKOUT_HOLD, LIVE, type RunEntry } from "./run-registry";
import { getStateDir } from "./state-paths";
import { useTempHome } from "./test-env.testing";

const home = useTempHome();

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

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
		}
		await Bun.sleep(25);
	}
}

describe("linkReadyFingerprint and appsToRestartForLinks", () => {
	const spec: ResolvedLinkConfig = {
		project: "kanpla-backend",
		apps: ["core"],
	};

	it("returns undefined while expected or any apps are starting", () => {
		expect(linkReadyFingerprint(undefined, spec)).toBe("down");
		expect(linkReadyFingerprint(undefined, { ...spec, disabled: true })).toBe(
			"disabled",
		);

		expect(
			linkReadyFingerprint(
				{
					project: "kanpla-backend",
					projectName: "kanpla-backend-main",
					root: "/code/backend",
					worktree: null,
					ports: {},
					urls: {},
					loopbackUrls: {},
					publicUrls: {},
					captured: {},
					env: {},
					appStatuses: {},
					serviceStatuses: {},
				},
				spec,
			),
		).toBeUndefined();

		expect(
			linkReadyFingerprint(
				{
					project: "kanpla-backend",
					projectName: "kanpla-backend-main",
					root: "/code/backend",
					worktree: null,
					ports: { core: 8180 },
					urls: { core: "http://localhost:8180" },
					loopbackUrls: { core: "http://localhost:8180" },
					publicUrls: {},
					captured: {},
					env: {},
					appStatuses: { core: "starting" },
					serviceStatuses: {},
				},
				spec,
			),
		).toBeUndefined();

		expect(
			linkReadyFingerprint(
				{
					project: "kanpla-backend",
					projectName: "kanpla-backend-main",
					root: "/code/backend",
					worktree: null,
					ports: { core: 8180 },
					urls: { core: "http://localhost:8180" },
					loopbackUrls: { core: "http://localhost:8180" },
					publicUrls: {},
					captured: {},
					env: {},
					appStatuses: { core: "ready" },
					serviceStatuses: {},
				},
				spec,
			),
		).toContain("http://localhost:8180");

		// A run whose services are still starting is in transition (undefined), not settled.
		expect(
			linkReadyFingerprint(
				{
					project: "kanpla-backend",
					projectName: "kanpla-backend-main",
					root: "/code/backend",
					worktree: null,
					ports: {},
					urls: {},
					loopbackUrls: {},
					publicUrls: {},
					captured: {},
					env: {},
					appStatuses: {},
					serviceStatuses: { postgres: "starting" },
				},
				{ project: "kanpla-backend", services: ["postgres"] },
			),
		).toBeUndefined();
	});

	it("selects apps by restartOn and link-wide onChange: restart", () => {
		const apps = {
			api: { restartOn: ["links.backend"] },
			frontend: { restartOn: ["links.backend", "links.auth"] },
			worker: { restartOn: undefined },
		};
		const links: Record<string, ResolvedLinkConfig> = {
			backend: { project: "kanpla-backend", onChange: "ignore" },
			auth: { project: "kanpla-auth", onChange: "restart" },
		};

		expect(appsToRestartForLinks(apps, links, ["backend"])).toEqual([
			{ app: "api", links: ["backend"] },
			{ app: "frontend", links: ["backend"] },
		]);

		expect(appsToRestartForLinks(apps, links, ["auth"])).toEqual([
			{ app: "api", links: ["auth"] },
			{ app: "frontend", links: ["auth"] },
			{ app: "worker", links: ["auth"] },
		]);
	});
});

describe("watchLinks", () => {
	it("ignores starting transitions and fires when a linked run settles ready or goes down", async () => {
		const monoRoot = realpathSync(mkdtempSync(join(home(), "watch-mono-")));
		const backendRoot = realpathSync(
			mkdtempSync(join(home(), "watch-backend-")),
		);
		const runsPath = join(getStateDir(), "runs.json");
		const linksConfig: Record<string, ResolvedLinkConfig> = {
			backend: { project: "kanpla-backend", apps: ["core"] },
		};

		await writeJsonDocument(runsPath, { version: 2, runs: [] });

		const controller = new AbortController();
		const events: string[][] = [];
		try {
			watchLinks({
				root: monoRoot,
				linksConfig,
				signal: controller.signal,
				debounceMs: 30,
				onChange: (aliases) => {
					events.push([...aliases]);
				},
			});

			// 1. Intermediate "starting" write must NOT fire.
			await writeJsonDocument(runsPath, {
				version: 2,
				runs: [
					makeRun({
						root: backendRoot,
						apps: [
							{
								name: "core",
								port: 8180,
								url: "http://localhost:8180",
								loopbackUrl: "http://localhost:8180",
								status: "starting",
							},
						],
					}),
				],
			});
			await Bun.sleep(100);
			expect(events).toEqual([]);

			// 2. Settling to "ready" fires once.
			const readyRun = makeRun({ root: backendRoot });
			await writeJsonDocument(runsPath, { version: 2, runs: [readyRun] });
			await waitFor(() => events.length === 1);
			expect(events).toEqual([["backend"]]);

			// 3. Rewriting identical ready data does not re-fire.
			await writeJsonDocument(runsPath, { version: 2, runs: [readyRun] });
			await Bun.sleep(100);
			expect(events).toEqual([["backend"]]);

			// 4. Removing the linked run fires a transition back to "down".
			await writeJsonDocument(runsPath, { version: 2, runs: [] });
			await waitFor(() => events.length === 2);
			expect(events).toEqual([["backend"], ["backend"]]);
		} finally {
			controller.abort();
		}
	});
});
