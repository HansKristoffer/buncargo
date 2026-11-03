import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CI_ENV_VARS } from "../core/runtime-flags";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import { standInForWatchdog } from "../core/watchdog.testing";

/**
 * An expired Infisical session, end to end through the real CLI: the run stops
 * with the login to run instead of waiting on the CLI's login flow.
 */

const BIN = join(import.meta.dir, "bin.ts");
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function project(login: "prompt" | "hang" | undefined) {
	const infisical = startFakeInfisical(login ? { cliLogin: login } : {});
	cleanups.push(() => infisical.stop());
	infisical.projects.p1 = { secrets: { API_KEY: "never-printed" } };
	const root = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-session-")));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));

	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "session-test", private: true }),
	);
	writeFileSync(
		join(root, "dev.config.ts"),
		`export default ${JSON.stringify({
			projectPrefix: "session-test",
			services: {},
			secrets: { projectId: "p1", siteUrl: infisical.siteUrl },
			apps: {
				api: { port: 39_871, devCommand: "sleep 30", secrets: {} },
			},
			tasks: { hello: { command: "true" } },
			options: { worktreeIsolation: false, hosts: false },
		})};`,
	);
	await standInForWatchdog(root);

	// A developer's machine: CI and an exported token only warn.
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: root,
		NO_COLOR: "1",
		BUNCARGO_HOSTS: "0",
		BUNCARGO_SYSTEMD_SCOPE: "0",
		BUNCARGO_INFISICAL_PATH: infisical.cliPath,
	};
	for (const name of [...CI_ENV_VARS, "INFISICAL_TOKEN"]) delete env[name];

	const run = async (...args: string[]) => {
		const startedAt = performance.now();
		const child = Bun.spawn([process.execPath, BIN, ...args], {
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const detachedLog = Bun.file(
			join(root, ".buncargo", "logs", "detached.log"),
		);
		const log = (await detachedLog.exists()) ? await detachedLog.text() : "";
		return {
			exitCode,
			output: stdout + stderr + log,
			stdout,
			ms: performance.now() - startedAt,
		};
	};
	return { infisical, run };
}

describe("an expired Infisical session", () => {
	for (const login of ["prompt", "hang"] as const) {
		it(`stops dev --detach within 3 seconds when the CLI would ${login}`, async () => {
			const { infisical, run } = await project(login);

			const result = await run("dev", "--detach");

			expect(result.exitCode).not.toBe(0);
			expect(result.output).toContain(
				`Fix: infisical login --domain=${infisical.siteUrl}`,
			);
			expect(result.output).not.toContain("never-printed");
			expect(result.ms).toBeLessThan(3_000);
			// Stopped before the secrets were listed or any app started.
			expect(infisical.requests).toEqual([]);
		}, 15_000);
	}

	it("stops a task on its own first fetch", async () => {
		const { infisical, run } = await project("prompt");

		const result = await run("run", "hello");

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(
			`Fix: infisical login --domain=${infisical.siteUrl}`,
		);
	}, 15_000);

	it("stops exec on its own first fetch", async () => {
		const { infisical, run } = await project("hang");

		const result = await run("exec", "--", "true");

		expect(result.exitCode).toBe(1);
		expect(result.output).toContain(
			`Fix: infisical login --domain=${infisical.siteUrl}`,
		);
		expect(result.ms).toBeLessThan(4_000);
	}, 15_000);

	it("secrets check exits 2 with the login, never a value", async () => {
		const { infisical, run } = await project("prompt");

		const result = await run("secrets", "check", "--json");

		expect(result.exitCode).toBe(2);
		const report = JSON.parse(result.stdout);
		expect(report).toMatchObject({
			ok: false,
			exitCode: 2,
			logins: [`infisical login --domain=${infisical.siteUrl}`],
		});
		expect(report.scopes).toHaveLength(1);
		expect(report.scopes[0]).toMatchObject({
			projectId: "p1",
			usedBy: ["config", "api"],
			ok: false,
		});
	}, 15_000);

	it("secrets check exits 0 and counts keys when the session works", async () => {
		const { run } = await project(undefined);

		const result = await run("secrets", "check");

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("config, api: p1 dev @");
		expect(result.output).toContain("(1 key)");
		expect(result.output).not.toContain("never-printed");
	}, 15_000);
});
