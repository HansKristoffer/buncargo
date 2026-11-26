import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeInfisical } from "../core/secrets/fake-infisical.testing";
import { clearScopeSecretsCache } from "../core/secrets/index";
import { useTempHome } from "../core/test-env.testing";
import type { AnyDevEnvironment } from "../types";
import { createDevEnvironment } from "./create-dev-environment";
import { runMigrationsSequentially } from "./migrations";

// Sessions and caches go under HOME: each test's own.
useTempHome();
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
	const savedPath = process.env.BUNCARGO_INFISICAL_PATH;
	process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
	const root = mkdtempSync(join(tmpdir(), "buncargo-exec-secrets-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	cleanups.push(() => {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
		if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
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
	const savedPath = process.env.BUNCARGO_INFISICAL_PATH;
	process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
	const root = mkdtempSync(join(tmpdir(), "buncargo-offline-secrets-"));
	cleanups.push(() => {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
		if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
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
		await env.start({
			onlyApps: ["api"],
			productionBuild: false,
			watchdog: false,
		});
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

it("layers multiple Infisical scopes in order for apps, exec, seed, and profile overrides", async () => {
	const infisical = startFakeInfisical();
	infisical.folders["kanpla:local:/backend"] = {
		secrets: { APP_KEY: "local-key", SHARED: "from-local" },
	};
	infisical.folders["kanpla:dev:/backend"] = {
		secrets: { APP_KEY: "dev-key", SHARED: "from-dev" },
	};
	infisical.folders["kanpla:prod:/functions"] = {
		secrets: {
			UNLEASH_TOKEN: "prod-unleash",
			SHARED: "from-prod",
			PROD_ADMIN: "never-injected",
		},
	};
	const savedPath = process.env.BUNCARGO_INFISICAL_PATH;
	process.env.BUNCARGO_INFISICAL_PATH = infisical.cliPath;
	const root = mkdtempSync(join(tmpdir(), "buncargo-layered-profiles-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: [] }));
	cleanups.push(() => {
		infisical.stop();
		rmSync(root, { recursive: true, force: true });
		if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
		else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
	});

	const config = {
		projectPrefix: "kanpla",
		services: {},
		secrets: {
			projectId: "kanpla",
			siteUrl: infisical.siteUrl,
			environment: "local",
		},
		env: () => ({
			FIREBASE_PROJECT_ID: "demo-kanpla",
			FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
		}),
		apps: {
			backend: {
				port: 3000,
				devCommand: false as const,
				secrets: [
					{ path: "/backend" },
					{
						environment: "prod",
						path: "/functions",
						only: ["UNLEASH_TOKEN", "SHARED"],
					},
				],
			},
		},
		profiles: {
			default: {
				env: { PROFILE_TAG: "local-default" },
			},
			dev: {
				env: (ports: Record<string, number>) => ({
					PROFILE_TAG: `cloud-${ports.backend}`,
					FIREBASE_PROJECT_ID: "kanpla-dev",
					// Clearing emulator host drops it from built env.
					FIRESTORE_EMULATOR_HOST: undefined,
				}),
				secrets: { environment: "dev" },
			},
			offline: {
				env: { PROFILE_TAG: "offline" },
				secrets: false as const,
			},
		},
	};

	const readVars = async (env: AnyDevEnvironment, app?: string) =>
		JSON.parse(
			(
				await env.exec(
					[
						"bun",
						"-e",
						"console.log(JSON.stringify({ appKey: process.env.APP_KEY ?? null, shared: process.env.SHARED ?? null, unleash: process.env.UNLEASH_TOKEN ?? null, prodAdmin: process.env.PROD_ADMIN ?? null, fb: process.env.FIREBASE_PROJECT_ID ?? null, emu: process.env.FIRESTORE_EMULATOR_HOST ?? null, tag: process.env.PROFILE_TAG ?? null }))",
					],
					{ app },
				)
			).stdout,
		);

	// Default profile applies `profiles.default.env` and uses `local` + `prod` layers.
	const localEnv = createDevEnvironment(config, { root });
	expect(await readVars(localEnv, "backend")).toEqual({
		appKey: "local-key",
		shared: "from-prod",
		unleash: "prod-unleash",
		prodAdmin: null,
		fb: "demo-kanpla",
		emu: "127.0.0.1:8080",
		tag: "local-default",
	});

	// `--profile=dev` switches base scope to `dev` (keeping explicit `prod` layer) and clears emulator host.
	const devEnv = createDevEnvironment(config, { root, profile: "dev" });
	expect(await readVars(devEnv, "backend")).toEqual({
		appKey: "dev-key",
		shared: "from-prod",
		unleash: "prod-unleash",
		prodAdmin: null,
		fb: "kanpla-dev",
		emu: null,
		tag: `cloud-${devEnv.ports.backend}`,
	});

	// `--profile=offline` disables secrets altogether.
	const offlineEnv = createDevEnvironment(config, {
		root,
		profile: "offline",
	});
	expect(await readVars(offlineEnv, "backend")).toEqual({
		appKey: null,
		shared: null,
		unleash: null,
		prodAdmin: null,
		fb: "demo-kanpla",
		emu: "127.0.0.1:8080",
		tag: "offline",
	});
});
