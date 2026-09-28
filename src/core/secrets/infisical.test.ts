import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AppConfig } from "../../types";
import {
	type FakeInfisical,
	startFakeInfisical,
} from "./fake-infisical.testing";
import {
	applySecretDefaults,
	clearScopeSecretsCache,
	DEFAULT_INFISICAL_SITE_URL,
	loadAppSecrets,
	loadScopeSecrets,
	missingRequiredSecrets,
	resolveScope,
	sessionOrganization,
} from "./infisical";

let fake: (FakeInfisical & { cliPath: string; home: string }) | undefined;
const saved = {
	home: process.env.HOME,
	path: process.env.BUNCARGO_INFISICAL_PATH,
};

function start(options: Parameters<typeof startFakeInfisical>[0] = {}) {
	fake = startFakeInfisical(options);
	process.env.HOME = fake.home;
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	fake.projects.p1 = { secrets: { OPENAI_API_KEY: "sk-project", BLANK: "" } };
	return fake;
}

function app(projectId: string, extra: Partial<AppConfig> = {}): AppConfig {
	return {
		port: 3000,
		devCommand: "true",
		...extra,
		secrets: { projectId, siteUrl: fake?.siteUrl, ...extra.secrets },
	} as AppConfig;
}

beforeEach(() => clearScopeSecretsCache());
afterEach(() => {
	fake?.stop();
	fake = undefined;
	clearScopeSecretsCache();
	for (const [key, value] of [
		["HOME", saved.home],
		["BUNCARGO_INFISICAL_PATH", saved.path],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("resolveScope", () => {
	it("defaults to hanzio's EU cloud and keeps the organization", () => {
		expect(DEFAULT_INFISICAL_SITE_URL).toBe("https://eu.infisical.com");
		expect(
			resolveScope(
				{ projectId: "p1" },
				{ organizationId: "org-a", environment: "staging" },
				{},
			),
		).toEqual({
			projectId: "p1",
			organizationId: "org-a",
			environment: "staging",
			siteUrl: "https://eu.infisical.com",
			path: "/",
		});
		expect(
			resolveScope({ projectId: "p1" }, undefined, { SECRETS_ENV: "qa" })
				?.environment,
		).toBe("qa");
		expect(resolveScope(undefined, undefined, {})).toBeUndefined();
	});
});

describe("applySecretDefaults", () => {
	it("resolves each opted-in app's scope, keeping its required keys", () => {
		const apps = {
			api: {
				port: 3000,
				devCommand: "true",
				secrets: { required: ["DB"] },
			} as AppConfig,
			plain: { port: 3001, devCommand: "true" } as AppConfig,
		};
		const resolved = applySecretDefaults(apps, { projectId: "p1" }, {});
		expect(resolved.api.secrets).toEqual({
			projectId: "p1",
			environment: "dev",
			siteUrl: "https://eu.infisical.com",
			path: "/",
			required: ["DB"],
		});
		expect(resolved.plain).toBe(apps.plain);
	});
});

describe("session tokens", () => {
	it("reads the organization claim", () => {
		start();
		expect(sessionOrganization("a.eyJvcmdhbml6YXRpb25JZCI6Im8xIn0.c")).toBe(
			"o1",
		);
		expect(sessionOrganization("garbage")).toBeUndefined();
	});
});

describe("loadAppSecrets", () => {
	it("fetches a shared scope once, over HTTP, with one CLI call", async () => {
		const infisical = start();
		const secrets = await loadAppSecrets(
			{ web: app("p1"), marketing: app("p1") },
			undefined,
			{ env: {} },
		);
		expect(secrets).toEqual({
			web: { OPENAI_API_KEY: "sk-project" },
			marketing: { OPENAI_API_KEY: "sk-project" },
		});
		expect(infisical.cliCalls()).toHaveLength(1);
		expect(infisical.cliCalls()[0]).toContain("user get token");
		expect(infisical.requests).toEqual(["GET /api/v4/secrets"]);
	});

	// Projects in two organizations, side by side, without `infisical switch`.
	it("scopes the session to the scope's organization", async () => {
		const infisical = start({ cliOrganization: "org-a" });
		infisical.projects.p2 = { secrets: { B: "2" } };
		const secrets = await loadAppSecrets(
			{
				a: app("p1", { secrets: { organizationId: "org-a" } }),
				b: app("p2", { secrets: { organizationId: "org-b" } }),
			},
			undefined,
			{ env: {} },
		);
		expect(secrets).toEqual({
			a: { OPENAI_API_KEY: "sk-project" },
			b: { B: "2" },
		});
		expect(
			infisical.requests.filter((entry) =>
				entry.includes("select-organization"),
			),
		).toHaveLength(1);
	});

	it("lets the folder's own value beat an imported one", async () => {
		const infisical = start();
		infisical.projects.p1 = {
			secrets: { A: "own" },
			imports: { A: "imported", B: "imported" },
		};
		expect(
			await loadAppSecrets({ api: app("p1") }, undefined, { env: {} }),
		).toEqual({
			api: { A: "own", B: "imported" },
		});
	});

	it("keeps the developer's own exported value", async () => {
		start();
		expect(
			await loadAppSecrets({ api: app("p1") }, undefined, {
				env: { OPENAI_API_KEY: "sk-local" },
			}),
		).toEqual({ api: {} });
	});

	it("leaves a machine identity to the app's own loader", async () => {
		const infisical = start();
		expect(
			await loadAppSecrets({ api: app("p1") }, undefined, {
				env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" },
			}),
		).toEqual({});
		expect(infisical.cliCalls()).toEqual([]);
	});

	it("warns with the fix, never the CLI's output, when the CLI fails", async () => {
		start({ cliFails: true });
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			expect(
				await loadAppSecrets({ api: app("p1") }, undefined, { env: {} }),
			).toEqual({
				api: {},
			});
		} finally {
			console.warn = warn;
		}
		expect(warnings[0]).toContain("infisical login --domain=");
		expect(warnings[0]).not.toContain("secret-looking");
	});

	it("reports MFA instead of guessing", async () => {
		start({ mfaOrganizations: ["org-mfa"] });
		await expect(
			loadScopeSecrets(
				{ projectId: "p1", organizationId: "org-mfa", siteUrl: fake?.siteUrl },
				{ env: {} },
			),
		).rejects.toThrow("requires MFA");
	});
});

describe("loadScopeSecrets with a machine identity", () => {
	it("uses universal auth and never the CLI", async () => {
		const infisical = start();
		expect(
			await loadScopeSecrets(
				{ projectId: "p1", siteUrl: infisical.siteUrl },
				{
					env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" },
				},
			),
		).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(infisical.cliCalls()).toEqual([]);
		expect(infisical.requests).toEqual([
			"POST /api/v1/auth/universal-auth/login",
			"GET /api/v4/secrets",
		]);
	});

	it("fails with the status and no body on bad credentials", async () => {
		const infisical = start();
		await expect(
			loadScopeSecrets(
				{ projectId: "p1", siteUrl: infisical.siteUrl },
				{
					env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "wrong" },
				},
			),
		).rejects.toThrow("universal-auth login failed (HTTP 401)");
	});
});

describe("missingRequiredSecrets", () => {
	it("names what each app would start without", () => {
		expect(
			missingRequiredSecrets(
				{
					api: app("p1", { secrets: { required: ["DB", "KEY"] } }),
					web: app("p1", { secrets: { required: ["KEY"] } }),
				},
				(name) => (name === "api" ? { KEY: "x" } : { KEY: "y" }),
			),
		).toEqual({ api: ["DB"] });
	});
});
