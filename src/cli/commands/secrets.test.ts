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
