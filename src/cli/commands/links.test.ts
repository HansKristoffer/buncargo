import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildRunEntry,
	publishRun,
	retireProjectRuns,
} from "../../core/run-registry";
import { freePorts, useTempHome } from "../../core/test-env.testing";
import type { EnvJson, LinksJson, StatusJson } from "../json-documents";

const home = useTempHome();
const BIN = join(import.meta.dir, "..", "bin.ts");
const PKG_ROOT = join(import.meta.dir, "..", "..", "..");

function runCliCommand(cwd: string, args: string[]) {
	const result = Bun.spawnSync([process.execPath, BIN, ...args], {
		cwd,
		env: { ...process.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function writeConsumerConfig(root: string, apiPort: number): void {
	const entry = join(PKG_ROOT, "src", "index.ts");
	writeFileSync(
		join(root, "dev.config.ts"),
		`import { defineDevConfig } from ${JSON.stringify(entry)};
export default defineDevConfig({
	projectPrefix: "kanpla",
	services: {},
	links: {
		backend: {
			project: "kanpla-backend",
			required: true,
			apps: ["core"],
		},
	},
	apps: {
		api: { port: ${apiPort}, devCommand: false },
	},
	env: (_ports, _urls, ctx) => ({
		NEXT_PUBLIC_BB_CORE_URL: ctx.links.backend?.urls.core,
	}),
	profiles: {
		cloud: {
			links: { backend: false },
		},
	},
});
`,
	);
}

describe("buncargo links CLI", () => {
	it("inspects links, enforces --check, pins/unpins worktrees, and feeds env --get and status --json", async () => {
		const [apiPort, corePortA, corePortB] = freePorts(3);
		const consumerRoot = realpathSync(mkdtempSync(join(home(), "cli-links-")));
		const backendA = realpathSync(mkdtempSync(join(home(), "cli-be-a-")));
		const backendB = realpathSync(mkdtempSync(join(home(), "cli-be-b-")));
		writeConsumerConfig(consumerRoot, apiPort);

		// 1. Not running yet: links --json shows not-running, --check exits 1.
		const notRunning = runCliCommand(consumerRoot, [
			"links",
			"--json",
			"--check",
		]);
		expect(notRunning.exitCode).toBe(1);
		const notRunningDoc = JSON.parse(notRunning.stdout) as LinksJson;
		expect(notRunningDoc.links[0]?.status).toBe("not-running");
		expect(notRunningDoc.errors[0]).toContain('Required link "backend"');

		// Cloud profile disables the link -> --check exits 0.
		const cloudCheck = runCliCommand(consumerRoot, [
			"links",
			"--json",
			"--check",
			"--profile=cloud",
		]);
		expect(cloudCheck.exitCode).toBe(0);
		const cloudDoc = JSON.parse(cloudCheck.stdout) as LinksJson;
		expect(cloudDoc.links[0]?.status).toBe("disabled");

		// 2. Publish two live backend checkouts -> ambiguous!
		const sessionA = crypto.randomUUID();
		const sessionB = crypto.randomUUID();
		await publishRun({
			...buildRunEntry({
				sessionId: sessionA,
				projectPrefix: "kanpla-backend",
				projectName: "kanpla-backend-a",
				root: backendA,
				isWorktree: false,
			}),
			apps: [
				{
					name: "core",
					port: corePortA,
					url: `http://localhost:${corePortA}`,
					loopbackUrl: `http://localhost:${corePortA}`,
					status: "ready",
				},
			],
			exports: { BACKEND_TAG: "from-a" },
		});
		await publishRun({
			...buildRunEntry({
				sessionId: sessionB,
				projectPrefix: "kanpla-backend",
				projectName: "kanpla-backend-b",
				root: backendB,
				isWorktree: true,
			}),
			branch: "feat/core",
			apps: [
				{
					name: "core",
					port: corePortB,
					url: `http://localhost:${corePortB}`,
					loopbackUrl: `http://localhost:${corePortB}`,
					status: "ready",
				},
			],
			exports: { BACKEND_TAG: "from-b" },
		});

		try {
			const ambiguous = runCliCommand(consumerRoot, [
				"links",
				"--json",
				"--check",
			]);
			expect(ambiguous.exitCode).toBe(1);
			const ambiguousDoc = JSON.parse(ambiguous.stdout) as LinksJson;
			expect(ambiguousDoc.links[0]?.status).toBe("ambiguous");
			expect(ambiguousDoc.links[0]?.candidates).toHaveLength(2);

			// 3. Pin backend to backendB -> links --check exits 0 and env/status see backendB.
			const pinned = runCliCommand(consumerRoot, [
				"links",
				"pin",
				"backend",
				backendB,
			]);
			expect(pinned.exitCode).toBe(0);

			const linked = runCliCommand(consumerRoot, [
				"links",
				"--json",
				"--check",
			]);
			expect(linked.exitCode).toBe(0);
			const linkedDoc = JSON.parse(linked.stdout) as LinksJson;
			expect(linkedDoc.links[0]?.status).toBe("linked");
			expect(linkedDoc.links[0]?.source).toBe("pinned");
			expect(linkedDoc.links[0]?.link?.root).toBe(backendB);
			expect(linkedDoc.links[0]?.link?.env).toEqual({ BACKEND_TAG: "from-b" });

			// `buncargo env --get links.backend.urls.core` and `NEXT_PUBLIC_BB_CORE_URL`
			const gotUrl = runCliCommand(consumerRoot, [
				"env",
				"--get",
				"links.backend.urls.core",
			]);
			expect(gotUrl.exitCode).toBe(0);
			expect(gotUrl.stdout.trim()).toBe(`http://localhost:${corePortB}`);

			const envAll = runCliCommand(consumerRoot, ["env"]);
			expect(envAll.exitCode).toBe(0);
			const envDoc = JSON.parse(envAll.stdout) as EnvJson;
			expect(envDoc.vars.NEXT_PUBLIC_BB_CORE_URL).toBe(
				`http://localhost:${corePortB}`,
			);
			expect(envDoc.links.backend?.env.BACKEND_TAG).toBe("from-b");

			// `buncargo status --json` includes links
			const statusRes = runCliCommand(consumerRoot, ["status", "--json"]);
			expect(statusRes.exitCode).toBe(0);
			const statusDoc = JSON.parse(statusRes.stdout) as StatusJson;
			expect(statusDoc.links[0]?.status).toBe("linked");
			expect(statusDoc.links[0]?.link?.root).toBe(backendB);

			// 4. Reject unknown link name, self-pin, and a live checkout of another project
			expect(
				runCliCommand(consumerRoot, ["links", "pin", "nope", backendA])
					.exitCode,
			).toBe(1);
			expect(
				runCliCommand(consumerRoot, ["links", "pin", "backend", consumerRoot])
					.exitCode,
			).toBe(1);

			const wrongRoot = realpathSync(mkdtempSync(join(home(), "cli-other-")));
			const wrongSession = crypto.randomUUID();
			await publishRun({
				...buildRunEntry({
					sessionId: wrongSession,
					projectPrefix: "other-repo",
					projectName: "other-repo-main",
					root: wrongRoot,
					isWorktree: false,
				}),
				apps: [],
			});
			try {
				const wrongPin = runCliCommand(consumerRoot, [
					"links",
					"pin",
					"backend",
					wrongRoot,
				]);
				expect(wrongPin.exitCode).toBe(1);
				expect(wrongPin.stderr + wrongPin.stdout).toContain(
					'running "other-repo"',
				);
			} finally {
				await retireProjectRuns({
					projectName: "other-repo-main",
					root: wrongRoot,
					sessionId: wrongSession,
					downed: [],
				});
			}

			// 5. Unpin returns to ambiguous state
			const unpinned = runCliCommand(consumerRoot, [
				"links",
				"unpin",
				"backend",
			]);
			expect(unpinned.exitCode).toBe(0);
			const afterUnpin = JSON.parse(
				runCliCommand(consumerRoot, ["links", "--json"]).stdout,
			) as LinksJson;
			expect(afterUnpin.links[0]?.status).toBe("ambiguous");
		} finally {
			await retireProjectRuns({
				projectName: "kanpla-backend-a",
				root: backendA,
				sessionId: sessionA,
				downed: [],
			});
			await retireProjectRuns({
				projectName: "kanpla-backend-b",
				root: backendB,
				sessionId: sessionB,
				downed: [],
			});
		}
	});
});
