import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import { clearScopeSecretsCache } from "../core/secrets/infisical";
import { createDevEnvironment } from "./create-dev-environment";
import { runMigrationsSequentially } from "./migrations";

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

it("runs app startup, seed, migrations and exec offline without fetching disabled scopes", async () => {
	const infisical = startFakeInfisical({ cliFails: true });
	const saved = {
		home: process.env.HOME,
		path: process.env.BUNCARGO_INFISICAL_PATH,
	};
	process.env.HOME = infisical.home;
	process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
	const root = mkdtempSync(join(tmpdir(), "buncargo-offline-secrets-"));
	cleanups.push(() => {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
		if (saved.home === undefined) delete process.env.HOME;
		else process.env.HOME = saved.home;
		if (saved.path === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = saved.path;
	});
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	writeFileSync(
		join(root, "read.ts"),
		'if (process.env.SYNTHETIC_KEY !== "test-value") throw new Error("Missing synthetic input"); console.log("offline-ok")',
	);
	writeFileSync(
		join(root, "app.ts"),
		"Bun.serve({port:Number(process.env.PORT),fetch:()=>new Response(process.env.SYNTHETIC_KEY)})",
	);
	const scope = { projectId: "must-not-fetch", siteUrl: infisical.siteUrl };
	const env = createDevEnvironment(
		{
			projectPrefix: "offline",
			services: {},
			secrets: false,
			apps: {
				api: {
					port: 3000,
					devCommand: "bun app.ts",
					healthEndpoint: "/",
					secrets: scope,
				},
			},
			seed: { command: "bun read.ts", secrets: scope },
			env: () => ({ SYNTHETIC_KEY: "test-value" }),
			options: { verbose: false, hosts: false },
		},
		{ root },
	);

	try {
		expect((await env.runSeed({ verbose: false })).status).toBe("succeeded");
		await env.start({ onlyApps: ["api"], productionBuild: false });
		expect(await (await fetch(env.urls.api)).text()).toBe("test-value");
		expect(
			(await env.exec(["bun", "read.ts"], { secrets: scope })).stdout.trim(),
		).toBe("offline-ok");
		await runMigrationsSequentially(
			[{ name: "isolated", command: "bun read.ts", secrets: scope }],
			env.exec,
		);
		expect(infisical.requests).toEqual([]);
		expect(infisical.cliCalls()).toEqual([]);
	} finally {
		await env.stop();
	}
});
