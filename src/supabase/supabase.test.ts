import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevEnvironment } from "../environment";
import type { AnyDevEnvironment, CheckContext, DevConfig } from "../types";
import { supabaseChecks } from "./checks";
import { supabase } from "./index";
import { supabaseKeys } from "./keys";
import { readSupabaseProject } from "./project";

const saved = {
	HOME: process.env.HOME,
	BUNCARGO_PORT_OFFSET: process.env.BUNCARGO_PORT_OFFSET,
};
const cwd = process.cwd();
let root = "";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "buncargo-supabase-"));
	writeFileSync(join(root, "package.json"), "{}");
	mkdirSync(join(root, "supabase"));
	writeFileSync(
		join(root, "supabase", "config.toml"),
		`project_id = "shared-by-every-worktree"

[api]
port = 54321

[db]
port = 54322
shadow_port = 54320

[studio]
enabled = false

# The section name older projects still have.
[inbucket]
port = 54424

[auth]
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["myapp://callback"]
`,
	);
	process.env.HOME = root;
	process.env.BUNCARGO_PORT_OFFSET = "100";
	process.chdir(root);
});

afterAll(() => {
	process.chdir(cwd);
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("supabaseKeys", () => {
	it("derives the keys the CLI hands a default local stack", () => {
		// Copied from `supabase status -o json` against CLI 2.119.0.
		expect(supabaseKeys()).toEqual({
			anonKey:
				"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
			serviceRoleKey:
				"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
			publishableKey: "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH",
			secretKey: "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz",
		});
		expect(
			supabaseKeys("a-project-specific-secret-of-32-characters").anonKey,
		).not.toBe(supabaseKeys().anonKey);
	});
});

describe("supabase()", () => {
	const config: DevConfig = {
		projectPrefix: "myapp",
		services: {},
		apps: {
			api: { port: 3000, devCommand: "bun dev" },
			web: { port: 5173, devCommand: "bun dev", requiredApps: ["api"] },
		},
		integrations: [supabase({ publicEnvPrefix: "VITE_" })],
	};

	it("gives this checkout's stack its own id, ports and auth URLs, and the apps its URLs and keys", () => {
		const env = createDevEnvironment(config, { root });
		const vars = env.buildEnvVars() as Record<string, string>;

		// Studio is disabled in the toml, so it is not a service either.
		expect(Object.keys(env.services).sort()).toEqual([
			"supabase",
			"supabaseDb",
			"supabaseMail",
		]);
		expect(vars).toMatchObject({
			SUPABASE_PROJECT_ID: env.projectName,
			SUPABASE_API_PORT: "54421",
			SUPABASE_DB_PORT: "54422",
			SUPABASE_DB_SHADOW_PORT: "54420",
			SUPABASE_LOCAL_SMTP_PORT: "54524",
			SUPABASE_URL: "http://localhost:54421",
			VITE_SUPABASE_URL: "http://localhost:54421",
			VITE_SUPABASE_ANON_KEY: supabaseKeys().anonKey,
			SUPABASE_DB_URL:
				"postgresql://postgres:postgres@localhost:54422/postgres",
			// The app nothing else depends on is where auth sends people back.
			SUPABASE_AUTH_SITE_URL: "http://localhost:5273",
		});
		expect(vars.SUPABASE_STUDIO_PORT).toBeUndefined();
		expect(vars.VITE_SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
		expect(vars.SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS?.split(",")).toEqual(
			expect.arrayContaining([
				"myapp://callback",
				"http://localhost:5273/**",
				"http://localhost:3100/**",
			]),
		);
		expect(supabase().config?.(config)?.migrations?.[0]).toMatchObject({
			name: "supabase",
			requiredServices: ["supabaseDb"],
		});
	});

	it("has no service for a component `supabase start` is told to skip", () => {
		const applied = supabase({ exclude: ["mailpit"] }).config?.(config);
		expect(Object.keys(applied?.services ?? {}).sort()).toEqual([
			"supabase",
			"supabaseDb",
		]);
	});

	it("lets the config's own env win over the integration's", () => {
		const env = createDevEnvironment(
			{ ...config, env: () => ({ SUPABASE_URL: "https://staging.example" }) },
			{ root },
		);
		expect(env.buildEnvVars()).toMatchObject({
			SUPABASE_URL: "https://staging.example",
		});
	});

	it("stops the stack by project id, deleting its data only on reset", () => {
		const stack = supabase().stacks?.supabase;
		const projectName = "myapp-t3code-e92a078e-t3code-e92a078e-feature";
		const down = stack?.down({ projectName, root, removeVolumes: false });
		expect(down?.slice(1, 3)).toEqual(["stop", "--project-id"]);
		expect(down?.[3]?.length).toBeLessThanOrEqual(40);
		expect(stack?.down({ projectName, root, removeVolumes: true })).toContain(
			"--no-backup",
		);
	});
});

describe("supabase checks", () => {
	const check = (name: string) => {
		const found = supabaseChecks({
			project: () => readSupabaseProject(root),
			workdir: () => root,
		}).find((entry) => entry.name === name);
		if (!found) throw new Error(`no check named ${name}`);
		return found;
	};

	it("refuses Apple's runtime, which leaves the CLI no Docker to drive", async () => {
		const ctx = (runtime: string) =>
			({
				root,
				env: { containerRuntime: runtime } as unknown as AnyDevEnvironment,
			}) as CheckContext;
		const runtimeCheck = check("Supabase runs on Docker");
		expect(await runtimeCheck.check(ctx("docker"))).toBe(true);
		expect(await runtimeCheck.check(ctx("apple"))).toMatchObject({ ok: false });
	});
});
