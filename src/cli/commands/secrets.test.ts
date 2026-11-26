import { afterEach, beforeEach, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CI_ENV_VARS } from "../../core/runtime-flags";
import { startFakeInfisical } from "../../core/secrets/fake-infisical.testing";

const cli = resolve(import.meta.dir, "../bin.ts");
let dir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "buncargo-secrets-cli-")));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** `buncargo secrets ls` in a project with `config`, under its own HOME. */
function secretsLs(config: string, args: string[]) {
	writeFileSync(
		join(dir, "dev.config.ts"),
		`export default { projectPrefix: "secrets", services: {}, ${config} };`,
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: join(dir, "home"),
	};
	for (const name of CI_ENV_VARS) delete env[name];
	const result = spawnSync(process.execPath, [cli, "secrets", "ls", ...args], {
		cwd: dir,
		env,
		encoding: "utf-8",
	});
	return { code: result.status, stderr: result.stderr };
}

const apps = `apps: { api: { port: 3000, devCommand: "true" }, web: { port: 3001, devCommand: "true", secrets: false } }`;

it("names the apps when --app is unknown", () => {
	const { code, stderr } = secretsLs(apps, ["--app=nope"]);
	expect(code).toBe(1);
	expect(stderr).toContain(
		'Unknown app "nope". Apps in dev.config.ts: api, web.',
	);
});

it("names the config change that gives an app a scope", () => {
	const withDefaults = `secrets: { projectId: "p1" }, ${apps}`;
	expect(secretsLs(withDefaults, ["--app=api"]).stderr).toContain(
		"Add apps.api.secrets: {} to dev.config.ts",
	);
	expect(secretsLs(apps, ["--app=api"]).stderr).toContain(
		"Set apps.api.secrets.projectId, or secrets.projectId for every app",
	);
	expect(secretsLs(withDefaults, ["--app=web"]).stderr).toContain(
		"dev.config.ts sets apps.web.secrets: false",
	);
});

/** `secrets ls --app=api` against a fake Infisical, without blocking it. */
async function secretsLsAgainst(
	infisical: ReturnType<typeof startFakeInfisical>,
	required: string[],
	exported: Record<string, string> = {},
) {
	writeFileSync(
		join(dir, "dev.config.ts"),
		`export default { projectPrefix: "secrets", services: {}, secrets: { projectId: "p1", siteUrl: ${JSON.stringify(infisical.siteUrl)} }, apps: { api: { port: 3000, devCommand: "true", secrets: { required: ${JSON.stringify(required)} } } } };`,
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		...exported,
		HOME: infisical.home,
		BUNCARGO_INFISICAL_PATH: infisical.cliPath,
	};
	for (const name of CI_ENV_VARS) delete env[name];
	delete env.INFISICAL_CLIENT_ID;
	delete env.INFISICAL_CLIENT_SECRET;
	const proc = Bun.spawn(
		[process.execPath, cli, "secrets", "ls", "--app=api"],
		{ cwd: dir, env, stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, output: Bun.stripANSI(stdout + stderr) };
}

// `dev` refuses on a key that is empty everywhere and starts with one only
// the computed env provides; `secrets ls` has to say the same.
it("judges required keys the way dev does", async () => {
	const infisical = startFakeInfisical();
	infisical.projects.p1 = { secrets: { STRIPE_KEY: "sk" } };
	try {
		const computed = await secretsLsAgainst(infisical, [
			"STRIPE_KEY",
			"API_PORT",
		]);
		expect(computed.output).toMatch(/API_PORT\s+computed/);
		expect(computed.code).toBe(0);

		const blank = await secretsLsAgainst(infisical, ["STRIPE_KEY", "BLANK"], {
			BLANK: "",
		});
		expect(blank.output).toMatch(/BLANK\s+missing/);
		expect(blank.output).toContain("Required secrets are missing: BLANK");
		expect(blank.code).toBe(1);
	} finally {
		infisical.stop();
	}
}, 30_000);

it("lists layered scopes and honors --profile in secrets ls and secrets check", async () => {
	const infisical = startFakeInfisical();
	infisical.folders["p1:local:/backend"] = {
		secrets: { LOCAL_ONLY: "1", SHARED: "from-local" },
	};
	infisical.folders["p1:dev:/"] = {
		secrets: { ROOT_DEV: "1" },
	};
	infisical.folders["p1:dev:/backend"] = {
		secrets: { DEV_ONLY: "1", SHARED: "from-dev" },
	};
	infisical.folders["p1:prod:/functions"] = {
		secrets: { UNLEASH_A: "ua", PROD_BLOCKED: "nope" },
	};

	writeFileSync(
		join(dir, "dev.config.ts"),
		`export default {
			projectPrefix: "secrets",
			services: {},
			secrets: { projectId: "p1", environment: "local", siteUrl: ${JSON.stringify(infisical.siteUrl)} },
			apps: {
				backend: {
					port: 3000,
					devCommand: "true",
					secrets: [
						{ path: "/backend", required: ["SHARED"] },
						{ environment: "prod", path: "/functions", only: ["UNLEASH_A"], required: ["UNLEASH_A"] },
					],
				},
			},
			profiles: {
				dev: { secrets: { environment: "dev" } },
				offline: { secrets: false },
			},
		};`,
	);

	const runCli = async (args: string[]) => {
		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: infisical.home,
			BUNCARGO_INFISICAL_PATH: infisical.cliPath,
		};
		for (const name of CI_ENV_VARS) delete env[name];
		delete env.INFISICAL_CLIENT_ID;
		delete env.INFISICAL_CLIENT_SECRET;
		const proc = Bun.spawn([process.execPath, cli, "secrets", ...args], {
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
		return {
			code,
			stdout: Bun.stripANSI(stdout),
			stderr: Bun.stripANSI(stderr),
		};
	};

	try {
		const localLs = await runCli(["ls", "--app=backend"]);
		expect(localLs.code).toBe(0);
		expect(localLs.stdout).toContain("p1 local/backend");
		expect(localLs.stdout).toContain("p1 prod/functions");
		expect(localLs.stdout).toMatch(/LOCAL_ONLY\s+infisical/);
		expect(localLs.stdout).toMatch(/UNLEASH_A\s+infisical/);
		expect(localLs.stdout).not.toContain("PROD_BLOCKED");

		const devLs = await runCli(["ls", "--app=backend", "--profile=dev"]);
		expect(devLs.code).toBe(0);
		expect(devLs.stdout).toContain("p1 dev/backend");
		expect(devLs.stdout).toContain("p1 prod/functions");
		expect(devLs.stdout).toMatch(/DEV_ONLY\s+infisical/);
		expect(devLs.stdout).not.toContain("LOCAL_ONLY");

		const devCheck = await runCli(["check", "--json", "--profile=dev"]);
		expect(devCheck.code).toBe(0);
		const checkJson = JSON.parse(devCheck.stdout) as {
			ok: boolean;
			scopes: { environment: string; path: string }[];
		};
		expect(checkJson.ok).toBe(true);
		expect(
			checkJson.scopes.some(
				(s) => s.environment === "dev" && s.path === "/backend",
			),
		).toBe(true);
		expect(
			checkJson.scopes.some(
				(s) => s.environment === "prod" && s.path === "/functions",
			),
		).toBe(true);

		const offlineCheck = await runCli(["check", "--json", "--profile=offline"]);
		expect(offlineCheck.code).toBe(0);
		expect(JSON.parse(offlineCheck.stdout).scopes).toEqual([]);
	} finally {
		infisical.stop();
	}
}, 30_000);
