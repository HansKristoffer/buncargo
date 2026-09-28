import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import { clearScopeSecretsCache } from "../core/secrets/infisical";
import { createDevEnvironment } from "./create-dev-environment";

const cleanups: (() => void)[] = [];
afterEach(() => {
	clearScopeSecretsCache();
	for (const cleanup of cleanups.splice(0)) cleanup();
});

/**
 * Secrets used to reach app processes only: migrations, the seed, `exec` and
 * hooks ran without them, which is why projects copied secrets into `.env`.
 */
it("gives exec the app's scope, else the config's, beneath the computed env", async () => {
	const infisical = startFakeInfisical();
	infisical.projects.shared = {
		secrets: { SHARED: "config-scope", DATABASE_URL: "wrong" },
	};
	infisical.projects.api = { secrets: { API_ONLY: "api-scope" } };
	const saved = {
		home: process.env.HOME,
		path: process.env.BUNCARGO_INFISICAL_PATH,
	};
	process.env.HOME = infisical.home;
	process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
	const root = mkdtempSync(join(tmpdir(), "buncargo-exec-secrets-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	cleanups.push(() => {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
		process.env.HOME = saved.home;
		if (saved.path === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = saved.path;
	});

	const env = createDevEnvironment(
		{
			projectPrefix: "sec",
			services: { postgres: { port: 5432 } },
			apps: {
				api: {
					port: 3000,
					devCommand: false,
					secrets: { projectId: "api" },
				},
			},
			secrets: { projectId: "shared", siteUrl: infisical.siteUrl },
		},
		{ root },
	);
	const read = async (options: Parameters<typeof env.exec>[1] = {}) =>
		JSON.parse(
			(
				await env.exec(
					[
						"bun",
						"-e",
						"console.log(JSON.stringify({ s: process.env.SHARED ?? null, a: process.env.API_ONLY ?? null, db: process.env.DATABASE_URL }))",
					],
					options,
				)
			).stdout,
		);

	const plain = await read();
	expect(plain.s).toBe("config-scope");
	// The computed DATABASE_URL beats the scope's key of the same name.
	expect(plain.db).toStartWith("postgresql://");
	expect(await read({ app: "api" })).toMatchObject({ a: "api-scope", s: null });
	expect(await read({ secrets: false })).toMatchObject({ s: null, a: null });
});
