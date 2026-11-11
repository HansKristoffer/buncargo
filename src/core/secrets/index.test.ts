import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig, SecretsScopeConfig } from "../../types";
import { useTempHome } from "../test-env.testing";
import { sessionOrganization } from "./auth";
import { InfisicalLoginError } from "./errors";
import {
	type FakeInfisical,
	startFakeInfisical,
} from "./fake-infisical.testing";
import {
	applySecretDefaults,
	clearScopeSecretsCache,
	describeSecretsError,
	ensureSecretsSession,
	fetchScopeSecrets,
	type InfisicalScope,
	loadAppSecrets,
	loadScopeSecrets,
	missingRequiredSecrets,
	resolveScope,
} from "./index";

let fake: (FakeInfisical & { cliPath: string; home: string }) | undefined;
const home = useTempHome();
const savedPath = process.env.BUNCARGO_INFISICAL_PATH;

function start(options: Parameters<typeof startFakeInfisical>[0] = {}) {
	fake = startFakeInfisical(options);
	process.env.BUNCARGO_INFISICAL_PATH = fake.cliPath;
	fake.projects.p1 = { secrets: { OPENAI_API_KEY: "sk-project", BLANK: "" } };
	return fake;
}

/** No credentials, and the test's home: the developer's identity file is never read. */
function noIdentity(): NodeJS.ProcessEnv {
	return { HOME: home() };
}

/** A resolved scope on the running fake, as the environment layer passes one. */
function scopeOf(
	projectId: string,
	extra: SecretsScopeConfig = {},
): InfisicalScope {
	const scope = resolveScope(
		{ projectId, siteUrl: fake?.siteUrl, ...extra },
		undefined,
		{},
	);
	if (!scope) throw new Error("Missing test scope");
	return scope;
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
	if (savedPath === undefined) delete process.env.BUNCARGO_INFISICAL_PATH;
	else process.env.BUNCARGO_INFISICAL_PATH = savedPath;
});

describe("shared request cancellation", () => {
	async function waitUntil(ready: () => boolean) {
		const deadline = Date.now() + 3000;
		while (!ready() && Date.now() < deadline) await Bun.sleep(5);
		expect(ready()).toBe(true);
	}

	it.each([0, 1])(
		"cancels waiter %s without cancelling the other scope consumer",
		async (index) => {
			const infisical = start({ holdRequests: true });
			const controllers = [new AbortController(), new AbortController()];
			const pending = controllers.map((controller) =>
				loadScopeSecrets(scopeOf("p1"), {
					signal: controller.signal,
					env: noIdentity(),
				}),
			);
			const cancelled = pending[index].then(
				() => "fulfilled",
				(error) => error,
			);
			const survivor = pending[1 - index];
			void survivor.catch(() => {});
			await waitUntil(() => infisical.requests.includes("GET /api/v4/secrets"));
			controllers[index].abort(new Error("Cancelled waiter"));
			expect(await cancelled).toMatchObject({ message: "Cancelled waiter" });
			infisical.release();
			expect(await survivor).toEqual({ OPENAI_API_KEY: "sk-project" });
			expect(
				infisical.requests.filter((path) => path === "GET /api/v4/secrets"),
			).toHaveLength(1);
			expect(infisical.cliCalls()).toHaveLength(1);
		},
	);

	it("keeps shared CLI authentication alive for a different scope", async () => {
		const infisical = start({ holdCli: true });
		infisical.projects.p2 = { secrets: { KEY: "second" } };
		const controller = new AbortController();
		const first = loadScopeSecrets(scopeOf("p1"), {
			signal: controller.signal,
			env: noIdentity(),
		});
		const cancelled = first.then(
			() => "fulfilled",
			(error) => error,
		);
		const second = loadScopeSecrets(scopeOf("p2"), { env: noIdentity() });
		void second.catch(() => {});
		await waitUntil(() => infisical.cliCalls().length > 0);
		controller.abort(new Error("Cancelled scope"));
		expect(await cancelled).toMatchObject({ message: "Cancelled scope" });
		infisical.release();
		expect(await second).toEqual({ KEY: "second" });
		expect(infisical.cliCalls()).toHaveLength(1);
	});

	it("applies a waiter's timeout without shortening another wait", async () => {
		const infisical = start({ holdRequests: true });
		const scope = scopeOf("p1");
		const first = fetchScopeSecrets(scope, {
			timeoutMs: 10,
			env: noIdentity(),
		});
		const timedOut = first.then(
			() => "fulfilled",
			(error) => error,
		);
		const second = fetchScopeSecrets(scope, {
			timeoutMs: 3000,
			env: noIdentity(),
		});
		void second.catch(() => {});
		expect(await timedOut).toMatchObject({
			message: "Infisical did not answer within 10ms.",
		});
		infisical.release();
		expect(await second).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(infisical.cliCalls()).toHaveLength(1);
	});
});

describe("resolveScope", () => {
	it("defaults to hanzio's EU cloud and keeps the organization", () => {
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
			{ env: noIdentity() },
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
			{ env: noIdentity() },
		);
		expect(infisical.cliCalls()).toHaveLength(1);
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
			await loadAppSecrets({ api: app("p1") }, { env: noIdentity() }),
		).toEqual({
			api: { A: "own", B: "imported" },
		});
	});

	it("keeps the developer's own exported value", async () => {
		start();
		expect(
			await loadAppSecrets(
				{ api: app("p1") },
				{ env: { ...noIdentity(), OPENAI_API_KEY: "sk-local" } },
			),
		).toEqual({ api: {} });
	});

	it("injects machine-auth secrets once per scope across apps and commands", async () => {
		const infisical = start();
		expect(
			await loadAppSecrets(
				{ api: app("p1"), web: app("p1") },
				{
					env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" },
				},
			),
		).toEqual({
			api: { OPENAI_API_KEY: "sk-project" },
			web: { OPENAI_API_KEY: "sk-project" },
		});
		await loadScopeSecrets(scopeOf("p1"), {
			env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" },
		});
		expect(infisical.cliCalls()).toEqual([]);
		expect(infisical.requests).toEqual([
			"POST /api/v1/auth/universal-auth/login",
			"GET /api/v4/secrets",
		]);
	});

	it("stops on a missing session with the login, never the CLI's output", async () => {
		start({ cliFails: true });
		const failure = await loadAppSecrets(
			{ api: app("p1") },
			{ env: noIdentity() },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(InfisicalLoginError);
		expect(describeSecretsError(failure)).toContain(
			`infisical login --domain=${fake?.siteUrl}`,
		);
		expect(describeSecretsError(failure)).not.toContain("secret-looking");
	});

	for (const [where, extra] of [
		["in CI", { CI: "true" }],
		["with an exported token", { INFISICAL_TOKEN: "st.exported" }],
	] as const) {
		it(`only warns about a missing session ${where}`, async () => {
			start({ cliFails: true });
			const warnings: string[] = [];
			const warn = console.warn;
			console.warn = (message: unknown) => warnings.push(String(message));
			try {
				expect(
					await loadAppSecrets(
						{ api: app("p1") },
						{ env: { ...noIdentity(), ...extra } },
					),
				).toEqual({ api: {} });
			} finally {
				console.warn = warn;
			}
			expect(warnings[0]).toContain("infisical login --domain=");
			expect(warnings[0]).not.toContain("secret-looking");
		});
	}

	it("warns and goes on when a signed-in scope cannot be read", async () => {
		start();
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			expect(
				await loadAppSecrets({ api: app("missing") }, { env: noIdentity() }),
			).toEqual({ api: {} });
		} finally {
			console.warn = warn;
		}
		expect(warnings[0]).toContain("HTTP 404");
	});

	it("reports MFA instead of guessing", async () => {
		start({ mfaOrganizations: ["org-mfa"] });
		await expect(
			loadScopeSecrets(scopeOf("p1", { organizationId: "org-mfa" }), {
				env: noIdentity(),
			}),
		).rejects.toThrow("requires MFA");
	});
});

describe("loadScopeSecrets with a machine identity", () => {
	it("uses universal auth and never the CLI", async () => {
		const infisical = start();
		expect(
			await loadScopeSecrets(scopeOf("p1"), {
				env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" },
			}),
		).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(infisical.cliCalls()).toEqual([]);
		expect(infisical.requests).toEqual([
			"POST /api/v1/auth/universal-auth/login",
			"GET /api/v4/secrets",
		]);
	});

	it("reads the machine identity file in the given environment's home", async () => {
		const infisical = start();
		// Not process.env.HOME: the home the call is given.
		const elsewhere = join(infisical.home, "elsewhere");
		const write = (siteUrl: string) => {
			mkdirSync(join(elsewhere, ".infisical"), { recursive: true });
			writeFileSync(
				join(elsewhere, ".infisical", "universal-auth.json"),
				JSON.stringify({ clientId: "id", clientSecret: "right", siteUrl }),
			);
		};
		write(infisical.siteUrl);
		expect(
			await loadScopeSecrets(scopeOf("p1"), { env: { HOME: elsewhere } }),
		).toEqual({ OPENAI_API_KEY: "sk-project" });
		expect(infisical.cliCalls()).toEqual([]);

		// Another instance's identity is never sent here: the CLI session is used.
		clearScopeSecretsCache();
		write("https://other.example.com");
		await loadScopeSecrets(scopeOf("p1"), { env: { HOME: elsewhere } }).catch(
			() => {},
		);
		expect(infisical.cliCalls().length).toBeGreaterThan(0);
	});

	it("names the scope when Infisical has no such project", async () => {
		start();
		const error = await loadScopeSecrets(scopeOf("nope"), {
			env: noIdentity(),
		}).catch((caught: unknown) => caught);
		expect(describeSecretsError(error)).toBe(
			`Infisical list secrets failed (HTTP 404). Fix: check that project nope has environment "dev" and path "/" on ${fake?.siteUrl}; a 404 usually means one of them is misspelled or missing.`,
		);
	});

	it("fails with the status and no body on bad credentials", async () => {
		start();
		await expect(
			loadScopeSecrets(scopeOf("p1"), {
				env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "wrong" },
			}),
		).rejects.toThrow("universal-auth login failed (HTTP 401)");
	});
});

describe("a machine identity across scopes", () => {
	it("signs in once per site and lists each scope: N scopes, N+1 calls", async () => {
		const infisical = start();
		infisical.projects.p2 = { secrets: { B: "2" } };
		infisical.projects.p3 = { secrets: { C: "3" } };
		mkdirSync(join(home(), ".infisical"), { recursive: true });
		writeFileSync(
			join(home(), ".infisical", "universal-auth.json"),
			JSON.stringify({
				clientId: "id",
				clientSecret: "right",
				siteUrl: infisical.siteUrl,
			}),
		);

		expect(
			await loadAppSecrets(
				{ a: app("p1"), b: app("p2"), c: app("p3") },
				{ env: noIdentity() },
			),
		).toEqual({
			a: { OPENAI_API_KEY: "sk-project" },
			b: { B: "2" },
			c: { C: "3" },
		});
		expect(infisical.cliCalls()).toEqual([]);
		expect(infisical.requests.sort()).toEqual([
			"GET /api/v4/secrets",
			"GET /api/v4/secrets",
			"GET /api/v4/secrets",
			"POST /api/v1/auth/universal-auth/login",
		]);
	});
});

describe("what a scope injects", () => {
	async function outputOf(work: () => Promise<unknown>) {
		const lines: string[] = [];
		const { log, warn } = console;
		console.log = (message: unknown) => lines.push(`log ${message}`);
		console.warn = (message: unknown) => lines.push(`warn ${message}`);
		try {
			return { result: await work(), lines };
		} finally {
			Object.assign(console, { log, warn });
		}
	}

	it("keeps only the listed keys, drops excluded ones, and names what each scope injects", async () => {
		const infisical = start();
		infisical.projects.p1 = {
			secrets: {
				DATABASE_URL: "postgres://x",
				RESEND_KEY: "re_1",
				SENTRY: "s",
			},
		};
		const apps = {
			api: app("p1", { secrets: { exclude: ["RESEND_KEY"] } }),
			worker: app("p1", { secrets: { only: ["SENTRY", "MISSING"] } }),
		};

		const first = await outputOf(() =>
			loadAppSecrets(apps, { env: noIdentity() }),
		);
		const again = await outputOf(() =>
			loadAppSecrets(apps, { env: noIdentity() }),
		);

		expect(first.result).toEqual({
			api: { DATABASE_URL: "postgres://x", SENTRY: "s" },
			worker: { SENTRY: "s" },
		});
		expect(first.lines.sort()).toEqual([
			expect.stringMatching(
				/^log .*Infisical p1 dev for api: DATABASE_URL, SENTRY$/,
			),
			expect.stringMatching(/^log .*Infisical p1 dev for worker: SENTRY$/),
		]);
		expect(first.lines.join("\n")).not.toContain("postgres://x");
		expect(infisical.requests).toEqual(["GET /api/v4/secrets"]);
		// One line per scope per run, though a start loads its secrets twice.
		expect(again.lines).toEqual([]);
	});

	it("warns when the shell's SECRETS_ENV hands dev another environment", async () => {
		start();
		const env = { ...noIdentity(), SECRETS_ENV: "prod" };
		const apps = applySecretDefaults({ api: app("p1") }, undefined, env);

		const { lines } = await outputOf(() => loadAppSecrets(apps, { env }));

		expect(lines).toEqual([
			expect.stringMatching(
				/^warn .*SECRETS_ENV=prod in this shell: api get Infisical p1 prod: OPENAI_API_KEY\. Unset SECRETS_ENV/,
			),
		]);
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

it("retries a rejected session token after login and clears settled tokens", async () => {
	const infisical = start({ cliFails: true });
	const scope = scopeOf("p1");
	await expect(loadScopeSecrets(scope, { env: noIdentity() })).rejects.toThrow(
		"No Infisical session",
	);
	const cli = readFileSync(infisical.cliPath, "utf8");
	const payload = Buffer.from(
		JSON.stringify({ organizationId: "org-a" }),
	).toString("base64url");
	writeFileSync(
		infisical.cliPath,
		cli.replace(
			'echo "secret-looking stderr" >&2\nexit 1',
			`echo a.${payload}.sig`,
		),
	);
	expect(await loadScopeSecrets(scope, { env: noIdentity() })).toEqual({
		OPENAI_API_KEY: "sk-project",
	});
	expect(infisical.cliCalls()).toHaveLength(2);
	clearScopeSecretsCache();
	await loadScopeSecrets(scope, { env: noIdentity() });
	expect(infisical.cliCalls()).toHaveLength(3);
});

describe("a session token Infisical stopped accepting", () => {
	it("is asked for again once, for the next scope of a long run", async () => {
		const infisical = start();
		infisical.projects.p2 = { secrets: { B: "2" } };
		await loadScopeSecrets(scopeOf("p1"), { env: noIdentity() });
		infisical.rotateSession();

		expect(
			await loadScopeSecrets(scopeOf("p2"), { env: noIdentity() }),
		).toEqual({ B: "2" });
		expect(infisical.cliCalls()).toHaveLength(2);
	});

	it("is asked for again when the organization exchange refuses it", async () => {
		const infisical = start({ cliOrganization: "org-a" });
		infisical.projects.p2 = { secrets: { B: "2" } };
		await loadScopeSecrets(scopeOf("p1"), { env: noIdentity() });
		infisical.rotateSession();

		expect(
			await loadScopeSecrets(scopeOf("p2", { organizationId: "org-b" }), {
				env: noIdentity(),
			}),
		).toEqual({ B: "2" });
		expect(infisical.cliCalls()).toHaveLength(2);
	});

	it("asks once, and fails with the login when the CLI hands back the same one", async () => {
		const infisical = start();
		infisical.projects.p2 = { secrets: { B: "2" } };
		await loadScopeSecrets(scopeOf("p1"), { env: noIdentity() });
		infisical.revokeSession();

		const error = await loadScopeSecrets(scopeOf("p2"), {
			env: noIdentity(),
		}).catch((caught: unknown) => caught);

		expect(describeSecretsError(error)).toContain("HTTP 401");
		expect(describeSecretsError(error)).toContain("infisical login");
		expect(infisical.cliCalls()).toHaveLength(2);
	});
});

it("never loads disabled scopes, even with machine credentials and explicit app scopes", async () => {
	const infisical = start();
	const disabledApp: AppConfig = {
		port: 3000,
		devCommand: "true",
		secrets: false,
	};
	const defaults = { projectId: "p1", siteUrl: infisical.siteUrl };
	const env = { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" };

	expect(resolveScope(false, defaults, env)).toBeUndefined();
	expect(resolveScope(defaults, false, env)).toBeUndefined();
	expect(
		await loadAppSecrets(applySecretDefaults({ disabledApp }, defaults, env), {
			env,
		}),
	).toEqual({});
	expect(
		await loadAppSecrets(applySecretDefaults({ api: app("p1") }, false, env), {
			env,
		}),
	).toEqual({});
	expect(applySecretDefaults({ api: app("p1") }, false, env).api.secrets).toBe(
		false,
	);
	expect(infisical.requests).toEqual([]);
	expect(infisical.cliCalls()).toEqual([]);
});

it("does not reuse a machine-auth scope after credentials change", async () => {
	const infisical = start();
	const scope = scopeOf("p1");
	await loadScopeSecrets(scope, {
		env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "right" },
	});

	await expect(
		loadScopeSecrets(scope, {
			env: { INFISICAL_CLIENT_ID: "id", INFISICAL_CLIENT_SECRET: "wrong" },
		}),
	).rejects.toThrow("universal-auth login failed (HTTP 401)");
	expect(infisical.cliCalls()).toEqual([]);
	expect(infisical.requests).toEqual([
		"POST /api/v1/auth/universal-auth/login",
		"GET /api/v4/secrets",
		"POST /api/v1/auth/universal-auth/login",
	]);
});

describe("an expired session", () => {
	async function timedFailure(work: Promise<unknown>) {
		const startedAt = performance.now();
		const failure = await work.catch((error: unknown) => error);
		return { failure, ms: performance.now() - startedAt };
	}

	it("stops the CLI's login flow at once and names the login", async () => {
		const infisical = start({ cliLogin: "prompt" });

		const { failure, ms } = await timedFailure(
			loadScopeSecrets(scopeOf("p1"), { env: noIdentity() }),
		);

		expect(failure).toBeInstanceOf(InfisicalLoginError);
		expect(describeSecretsError(failure)).toBe(
			`The Infisical session for ${infisical.siteUrl} has expired: the CLI asked for a login. Run \`infisical login --domain=${infisical.siteUrl}\`.`,
		);
		expect(ms).toBeLessThan(1_000);
		expect(infisical.requests).toEqual([]);
	});

	it("bounds a CLI that waits on a login without a word", async () => {
		const infisical = start({ cliLogin: "hang" });

		const { failure, ms } = await timedFailure(
			loadScopeSecrets(scopeOf("p1"), { env: noIdentity() }),
		);

		expect(failure).toBeInstanceOf(InfisicalLoginError);
		expect(describeSecretsError(failure)).toContain(
			`did not answer within 2s for ${infisical.siteUrl}`,
		);
		expect(ms).toBeLessThan(3_000);
	});
});

describe("a failure that no login fixes", () => {
	async function warningsOf(work: () => Promise<unknown>) {
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (message: unknown) => warnings.push(String(message));
		try {
			return { result: await work(), warnings };
		} finally {
			console.warn = warn;
		}
	}

	/** A site that refuses connections: a server that has stopped. */
	function unreachableSite(): string {
		const server = Bun.serve({ port: 0, fetch: () => new Response() });
		const siteUrl = `http://localhost:${server.port}`;
		server.stop(true);
		return siteUrl;
	}

	for (const cli of [{ cliLogin: "hang" }, { cliFails: true }] as const) {
		it(`warns and goes on when the CLI ${"cliLogin" in cli ? "times out" : "fails"} and the site is unreachable`, async () => {
			const infisical = start(cli);
			const siteUrl = unreachableSite();
			const apps = { api: app("p1", { secrets: { siteUrl } }) };

			await ensureSecretsSession([scopeOf("p1", { siteUrl })], {
				env: noIdentity(),
			});
			const { result, warnings } = await warningsOf(() =>
				loadAppSecrets(apps, { env: noIdentity() }),
			);

			expect(result).toEqual({ api: {} });
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(`Infisical at ${siteUrl} is unreachable`);
			expect(warnings[0]).not.toContain("infisical login");
			// The session check found the site unreachable; the fetch does not
			// wait out the CLI and the probe again.
			expect(infisical.cliCalls()).toHaveLength(1);
		});
	}

	it("names the project and the session's organization on a 403", async () => {
		start({ cliOrganization: "org-a", forbiddenProjects: ["p1"] });

		const { result, warnings } = await warningsOf(() =>
			loadAppSecrets({ api: app("p1") }, { env: noIdentity() }),
		);

		expect(result).toEqual({ api: {} });
		expect(warnings[0]).toContain(
			"Infisical refused a session in organization org-a access to project p1 (HTTP 403).",
		);
		expect(warnings[0]).toContain("Fix: set secrets.organizationId");
		expect(warnings[0]).not.toContain("infisical login");
	});
});

describe("ensureSecretsSession", () => {
	it("shares its one CLI run with the fetches that follow", async () => {
		const infisical = start();
		const scope = scopeOf("p1");

		await ensureSecretsSession([scope, scopeOf("p2")], { env: noIdentity() });
		await loadScopeSecrets(scope, { env: noIdentity() });

		expect(infisical.cliCalls()).toHaveLength(1);
	});

	it("throws the login for a site without a session", async () => {
		const infisical = start({ cliFails: true });
		await expect(
			ensureSecretsSession([scopeOf("p1")], { env: noIdentity() }),
		).rejects.toThrow(`No Infisical session for ${infisical.siteUrl}.`);
	});

	it("needs no CLI for a machine identity", async () => {
		const infisical = start({ cliFails: true });
		await ensureSecretsSession([scopeOf("p1")], {
			env: {
				...noIdentity(),
				INFISICAL_CLIENT_ID: "id",
				INFISICAL_CLIENT_SECRET: "right",
			},
		});
		expect(infisical.cliCalls()).toEqual([]);
	});

	it("leaves a CLI that cannot start to the fetch's warning", async () => {
		const infisical = start();
		const notExecutable = join(infisical.home, "not-executable");
		writeFileSync(notExecutable, "");
		process.env.BUNCARGO_INFISICAL_PATH = notExecutable;

		await ensureSecretsSession([scopeOf("p1")], { env: noIdentity() });
		await expect(
			loadScopeSecrets(scopeOf("p1"), { env: noIdentity() }),
		).rejects.toThrow("The Infisical CLI is not installed.");
	});
});
