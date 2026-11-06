import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	anySignal,
	getErrorMessage,
	isRecord,
	mapValues,
	startTimer,
	timeoutSignal,
	trimTrailingSlash,
} from "hanzio";
import type { AppConfig, SecretsScopeConfig } from "../../types";
import { connectProcessEnv } from "../child-env";
import { registerAbortCleanup } from "../deadline";
import { withFileLock } from "../file-lock";
import {
	infisicalExportedToken,
	infisicalMachineCredentials,
	infisicalPathOverride,
	infisicalUniversalAuthFile,
	isCI,
	secretsEnvironment,
} from "../runtime-flags";
import { recordStartupMetric } from "../startup-metrics";
import { resolveUserHome, stateFilePath } from "../state-paths";
import { formatWarn } from "../style";
import {
	InfisicalLoginError,
	infisicalLoginCommand,
	SecretsError,
} from "./errors";
import { SharedRequestCache } from "./shared-request";

/**
 * Infisical, fetched once per scope per process, the way hanzio fetches it.
 *
 * Concurrent Infisical CLI processes hang indefinitely (reproduced with four
 * `user get token` calls on 0.41.98), which is what a monorepo does when three
 * apps each run their own loader at startup. So buncargo fetches here and
 * hands the values to the children: their loaders find the keys in
 * `process.env` and never spawn the CLI at all.
 *
 * Same approach and defaults as `hanzio/secrets`, so buncargo and app code
 * agree on what a scope means: the CLI is asked only for its session token
 * (under a machine-wide lock), which is scoped to the scope's organization
 * with `select-organization` when it is not already, and the secrets are
 * listed over HTTP. In CI a universal-auth identity replaces the CLI.
 *
 * Values are never logged, never written to a state file, and never put in an
 * error message: neither the CLI's stderr nor a response body is echoed.
 */

export interface InfisicalScope {
	projectId: string;
	/** Scope the CLI user session to this organization. */
	organizationId?: string;
	environment: string;
	siteUrl: string;
	/** Folder, matching hanzio's secretPath. Default "/". */
	path: string;
}

/** Same default as hanzio: the EU cloud. */
const DEFAULT_INFISICAL_SITE_URL = "https://eu.infisical.com";

/** One HTTP call or CLI run; only has to outlast a stalled network call. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * `infisical user get token` once it holds the lock: a local read and one
 * `checkAuth` round trip, well under a second. Bounds a CLI waiting silently
 * on a login nobody will finish; a login prompt it prints ends it at once.
 */
const CLI_TIMEOUT_MS = 2_000;
/** A shared load's ceiling, and every caller's default wait for one. */
const LOAD_TIMEOUT_MS = REQUEST_TIMEOUT_MS * 2;
/**
 * Every worktree on the machine queues on one lock, so allow a real queue:
 * all of the load's ceiling but the CLI run, so a long queue ends in the
 * lock's own error, which names it, rather than a generic "did not answer".
 */
const LOCK_TIMEOUT_MS = LOAD_TIMEOUT_MS - CLI_TIMEOUT_MS;

/**
 * The machine identity hanzio also reads when the environment names none:
 * `~/.infisical/universal-auth.json` (`INFISICAL_UNIVERSAL_AUTH_FILE` overrides
 * it), which agentgate keeps on every machine. Only used for its own instance.
 */
function identityFile(
	env: NodeJS.ProcessEnv,
	siteUrl: string,
): { clientId: string; clientSecret: string } | undefined {
	const file = infisicalUniversalAuthFile(env, resolveUserHome(env));
	if (!file) return undefined;
	let identity: {
		clientId?: unknown;
		clientSecret?: unknown;
		siteUrl?: unknown;
	};
	try {
		identity = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		// Never echo the file: it holds a client secret.
		throw new SecretsError(
			`The Infisical identity file ${file} is not valid JSON.`,
			"Set it again with agentgate logins identity, or remove it.",
		);
	}
	const { clientId, clientSecret, siteUrl: own } = identity;
	if (
		typeof clientId !== "string" ||
		!clientId ||
		typeof clientSecret !== "string" ||
		!clientSecret ||
		typeof own !== "string" ||
		!URL.canParse(own)
	)
		throw new SecretsError(
			`The Infisical identity file ${file} needs clientId, clientSecret and siteUrl.`,
			"Set it again with agentgate logins identity, or remove it.",
		);
	return new URL(own).origin === new URL(siteUrl).origin
		? { clientId, clientSecret }
		: undefined;
}

const cache = new SharedRequestCache<Record<string, string>>();
const warnedScopes = new Set<string>();
const sessionTokens = new SharedRequestCache<string>();

export function scopeKey(scope: InfisicalScope): string {
	return `${scope.siteUrl}|${scope.organizationId ?? ""}|${scope.projectId}|${scope.environment}|${scope.path}`;
}

/**
 * Resolve a scope against the config-level defaults.
 *
 * Returns undefined when no project id is in reach, which is how something
 * that declared nothing keeps today's behaviour.
 */
export function resolveScope(
	scope: SecretsScopeConfig | false | undefined,
	defaults: SecretsScopeConfig | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): InfisicalScope | undefined {
	if (scope === false || defaults === false) return undefined;

	const projectId = scope?.projectId ?? defaults?.projectId;
	if (!projectId) return undefined;
	const organizationId = scope?.organizationId ?? defaults?.organizationId;
	return {
		projectId,
		...(organizationId ? { organizationId } : {}),
		environment:
			scope?.environment ??
			defaults?.environment ??
			secretsEnvironment(env) ??
			"dev",
		siteUrl: trimTrailingSlash(
			scope?.siteUrl ?? defaults?.siteUrl ?? DEFAULT_INFISICAL_SITE_URL,
		),
		path: scope?.path ?? defaults?.path ?? "/",
	};
}

/**
 * Bake the config-level defaults into every opted-in app's own scope.
 *
 * The spawners read the scope off `app.secrets` and nothing else, so the
 * defaults have to be resolved before the apps leave the config. Passing them
 * alongside instead would be one more argument for the next spawner to forget,
 * which is exactly how the CLI's own spawn path missed this in 9.2.0.
 */
export function applySecretDefaults<TApps extends Record<string, AppConfig>>(
	apps: TApps,
	defaults: SecretsScopeConfig | false | undefined,
	env: NodeJS.ProcessEnv = process.env,
): TApps {
	if (defaults === false) {
		return mapValues(apps, (app) => ({ ...app, secrets: false })) as TApps;
	}

	if (!Object.values(apps).some((app) => app.secrets)) return apps;
	return mapValues(apps, (app) =>
		app.secrets
			? {
					...app,
					secrets: {
						...(resolveScope(app.secrets, defaults, env) ?? app.secrets),
						// Not part of the scope's identity, so resolveScope drops it.
						...(app.secrets.required ? { required: app.secrets.required } : {}),
					},
				}
			: app,
	) as TApps;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

/** A refusal Infisical answered, with its status; never its body. */
class InfisicalRequestError extends SecretsError {
	constructor(
		message: string,
		fix: string | undefined,
		readonly status: number,
	) {
		super(message, fix);
	}
}

async function request(
	scope: InfisicalScope,
	operation: string,
	path: string,
	init: RequestInit & { signal: AbortSignal },
): Promise<unknown> {
	let response: Response;
	try {
		response = await fetch(`${scope.siteUrl}${path}`, {
			...init,
			headers: {
				"content-type": "application/json",
				"user-agent": "buncargo",
				...init.headers,
			},
		});
	} catch {
		init.signal.throwIfAborted();
		throw new SecretsError(
			`Infisical ${operation}: ${scope.siteUrl} did not answer.`,
		);
	}
	if (!response.ok) {
		// The body is not echoed: it can quote what was sent.
		throw new InfisicalRequestError(
			`Infisical ${operation} failed (HTTP ${response.status}).`,
			failureFix(scope, response.status),
			response.status,
		);
	}
	try {
		return await response.json();
	} catch {
		throw new SecretsError(
			`Infisical ${operation} returned something other than JSON.`,
		);
	}
}

function failureFix(scope: InfisicalScope, status: number): string | undefined {
	if (status === 401 || status === 403)
		return infisicalLoginCommand(scope.siteUrl);
	if (status === 404)
		return `check that project ${scope.projectId} has environment "${scope.environment}" and path "${scope.path}" on ${scope.siteUrl}; a 404 usually means one of them is misspelled or missing.`;
	return undefined;
}

/** The organization a session token is scoped to; routing metadata only. */
export function sessionOrganization(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = JSON.parse(
			Buffer.from(
				payload.replace(/-/g, "+").replace(/_/g, "/"),
				"base64",
			).toString(),
		) as { organizationId?: unknown; subOrganizationId?: unknown };
		const org = claims.subOrganizationId ?? claims.organizationId;
		return typeof org === "string" ? org : undefined;
	} catch {
		return undefined;
	}
}

function tokenFrom(value: unknown, field: string, operation: string): string {
	const token = isRecord(value) ? value[field] : undefined;
	if (typeof token !== "string" || !token) {
		throw new SecretsError(`Infisical ${operation} returned no token.`);
	}
	return token;
}

// ─── Authentication ──────────────────────────────────────────────────────────

const cliBinary = () => infisicalPathOverride() ?? "infisical";

const cliSessionKey = (scope: InfisicalScope) =>
	`${scope.siteUrl}|${cliBinary()}`;

/** `infisical user get token`, under the machine-wide CLI lock. */
function cliSessionToken(
	scope: InfisicalScope,
	signal: AbortSignal,
): Promise<string> {
	const binary = cliBinary();
	return sessionTokens.get(
		cliSessionKey(scope),
		(sharedSignal) =>
			readCliSessionToken(
				scope,
				binary,
				timeoutSignal(LOAD_TIMEOUT_MS, sharedSignal),
			),
		signal,
	);
}

async function readCliSessionToken(
	scope: InfisicalScope,
	binary: string,
	signal: AbortSignal,
): Promise<string> {
	return withFileLock(
		stateFilePath("infisical-cli"),
		() => runCliSessionToken(scope, binary, signal),
		{ timeoutMs: LOCK_TIMEOUT_MS, signal },
	);
}

/**
 * One `infisical user get token`, which can never become an interactive login.
 *
 * With an expired session the CLI starts its login flow ("triggering login
 * flow", a browser callback or an email prompt) and waits for a person
 * forever. Its stdin is closed, its output is watched for that flow and the
 * whole run is bounded, so each of those ends in an {@link InfisicalLoginError}
 * within seconds. The output is only matched, never kept or echoed.
 */
async function runCliSessionToken(
	scope: InfisicalScope,
	binary: string,
	signal: AbortSignal,
): Promise<string> {
	recordStartupMetric("subprocesses");
	// Inherited machine tokens would override the signed-in user session.
	const {
		INFISICAL_TOKEN: _token,
		INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: _access,
		...env
	} = connectProcessEnv();
	const deadline = AbortSignal.timeout(CLI_TIMEOUT_MS);
	let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		child = Bun.spawn(
			[
				binary,
				"user",
				"get",
				"token",
				"--plain",
				"--silent",
				`--domain=${scope.siteUrl}`,
			],
			{
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...env,
					INFISICAL_DISABLE_UPDATE_CHECK: "true",
					INFISICAL_DISABLE_MIGRATION_NOTICES: "true",
				},
				signal: anySignal(signal, deadline),
				killSignal: "SIGKILL",
			},
		);
	} catch {
		throw new SecretsError(
			"The Infisical CLI is not installed.",
			"brew install infisical/get-cli/infisical",
		);
	}

	let loginFlow = false;
	const watch = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let text = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
			if (!loginFlow && startsLoginFlow(text)) {
				loginFlow = true;
				// Nothing of its own to clean up: it was waiting for a person.
				child.kill("SIGKILL");
			}
		}
		return text;
	};
	const stdout = watch(child.stdout);
	void stdout.catch(() => {});
	void watch(child.stderr).catch(() => {});
	const exitCode = await child.exited;
	signal.throwIfAborted();

	if (loginFlow)
		throw new InfisicalLoginError(
			`The Infisical session for ${scope.siteUrl} has expired: the CLI asked for a login.`,
			scope.siteUrl,
		);
	if (deadline.aborted)
		throw new InfisicalLoginError(
			`The Infisical CLI did not answer within ${CLI_TIMEOUT_MS / 1000}s for ${scope.siteUrl}: an expired session waits there on a login. If you are logged in, it was slow (the network, or a keychain prompt to allow): run the command again.`,
			scope.siteUrl,
		);
	const token = exitCode === 0 ? (await stdout).trim() : "";
	if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
		// Deliberately without the CLI's output, which can contain secrets.
		throw new InfisicalLoginError(
			`No Infisical session for ${scope.siteUrl}.`,
			scope.siteUrl,
		);
	}
	return token;
}

/**
 * The CLI's login flow, in any of the shapes it prints: "No valid login
 * session found, triggering login flow", "Your login session has expired.
 * Please run [infisical login]", an email or browser prompt. A token line has
 * no spaces, so only text with one is matched.
 */
function startsLoginFlow(output: string): boolean {
	return output
		.split("\n")
		.some(
			(line) =>
				line.includes(" ") && /login|log in|email|browser|expired/i.test(line),
		);
}

/**
 * A session token for the scope's organization. An already scoped session is
 * used as is (no second MFA challenge); the exchanged token stays in memory,
 * so the CLI's persisted session is never switched under another project.
 */
async function scopedSessionToken(
	scope: InfisicalScope,
	token: string,
	signal: AbortSignal,
): Promise<string> {
	if (
		!scope.organizationId ||
		sessionOrganization(token) === scope.organizationId
	) {
		return token;
	}
	const data = (await request(
		scope,
		"select-organization",
		"/api/v3/auth/select-organization",
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify({ organizationId: scope.organizationId }),
			signal,
		},
	)) as { isMfaEnabled?: unknown };
	if (data?.isMfaEnabled) {
		throw new SecretsError(
			"Infisical requires MFA for this organization.",
			`infisical login --domain=${scope.siteUrl} (and pick the organization)`,
		);
	}
	const scoped = tokenFrom(data, "token", "select-organization");
	if (sessionOrganization(scoped) !== scope.organizationId) {
		throw new SecretsError(
			"Infisical returned a session for a different organization.",
		);
	}
	return scoped;
}

async function machineToken(
	scope: InfisicalScope,
	credentials: NonNullable<ReturnType<typeof infisicalMachineCredentials>>,
	signal: AbortSignal,
): Promise<string> {
	return tokenFrom(
		await request(
			scope,
			"universal-auth login",
			"/api/v1/auth/universal-auth/login",
			{
				method: "POST",
				body: JSON.stringify(credentials),
				signal,
			},
		),
		"accessToken",
		"universal-auth login",
	);
}

// ─── Fetching ────────────────────────────────────────────────────────────────

interface ListedSecret {
	secretKey?: unknown;
	secretValue?: unknown;
}

/** Every key in the folder; imports first, so the folder's own values win. */
async function listSecrets(
	scope: InfisicalScope,
	token: string,
	signal: AbortSignal,
): Promise<Record<string, string>> {
	const query = new URLSearchParams({
		projectId: scope.projectId,
		environment: scope.environment,
		secretPath: scope.path,
		viewSecretValue: "true",
		expandSecretReferences: "true",
		includeImports: "true",
	});
	const data = (await request(
		scope,
		"list secrets",
		`/api/v4/secrets?${query}`,
		{
			method: "GET",
			headers: { authorization: `Bearer ${token}` },
			signal,
		},
	)) as { secrets?: ListedSecret[]; imports?: { secrets?: ListedSecret[] }[] };

	const values: Record<string, string> = {};
	const add = (entries: ListedSecret[] | undefined) => {
		for (const { secretKey, secretValue } of entries ?? []) {
			// An empty value would satisfy an app loader's "already in the
			// environment" check and hand it a blank secret. Leave it missing.
			if (
				typeof secretKey === "string" &&
				secretKey &&
				typeof secretValue === "string" &&
				secretValue
			) {
				values[secretKey] = secretValue;
			}
		}
	};
	for (const imported of data?.imports ?? []) add(imported.secrets);
	add(data?.secrets);
	return values;
}

/**
 * The scope's secrets with the user's CLI session. The session token is
 * cached for the process, so a long run's later scopes would keep sending one
 * Infisical stopped accepting (expired, or a logout elsewhere): on its 401
 * the token is forgotten and the CLI asked once more.
 */
async function listWithCliSession(
	scope: InfisicalScope,
	signal: AbortSignal,
): Promise<Record<string, string>> {
	const list = async (token: string) =>
		listSecrets(scope, await scopedSessionToken(scope, token, signal), signal);
	const token = await cliSessionToken(scope, signal);
	try {
		return await list(token);
	} catch (error) {
		const refused =
			error instanceof InfisicalRequestError && error.status === 401;
		if (!refused) throw error;
		sessionTokens.forget(cliSessionKey(scope), token);
	}
	return list(await cliSessionToken(scope, signal));
}

export async function fetchScopeSecrets(
	scope: InfisicalScope,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<Record<string, string>> {
	options.signal?.throwIfAborted();
	const env = options.env ?? process.env;
	const credentials =
		infisicalMachineCredentials(env) ?? identityFile(env, scope.siteUrl);
	// A different identity or rotated credential must authenticate for itself.
	// Keep raw credentials out of cache keys and diagnostic metadata.
	const authKey = credentials
		? createHash("sha256").update(JSON.stringify(credentials)).digest("hex")
		: "session";
	const key = `${scopeKey(scope)}|${authKey}`;
	const timeoutMs = options.timeoutMs ?? LOAD_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const waitSignal = anySignal(options.signal, timeout);
	const pending = cache.get(
		key,
		async (sharedSignal) => {
			// Transport has its own ceiling. A caller's shorter wait never
			// changes the request or authentication lifetime of another caller.
			const signal = timeoutSignal(LOAD_TIMEOUT_MS, sharedSignal);
			signal.throwIfAborted();
			if (!credentials) return await listWithCliSession(scope, signal);
			const token = await machineToken(scope, credentials, signal);
			return await listSecrets(scope, token, signal);
		},
		waitSignal,
	);
	if (options.signal) registerAbortCleanup(options.signal, pending);
	try {
		return await pending;
	} catch (error) {
		if (timeout.aborted && !options.signal?.aborted)
			throw new SecretsError(`Infisical did not answer within ${timeoutMs}ms.`);
		throw error;
	}
}

/** Whether `siteUrl` is reached with the user's CLI session, not an identity. */
function signsInWithCli(env: NodeJS.ProcessEnv, siteUrl: string): boolean {
	try {
		return !(infisicalMachineCredentials(env) ?? identityFile(env, siteUrl));
	} catch {
		// A broken identity file is the fetch's to report.
		return false;
	}
}

/**
 * Whether `error` stops a run rather than warning: a missing CLI session on a
 * developer's machine. In CI nobody can log in, and a shell that exports its
 * own token hands it to the apps' loaders, so both keep warning as before.
 */
export function stopsTheRun(
	error: unknown,
	env: NodeJS.ProcessEnv = process.env,
): error is InfisicalLoginError {
	return (
		error instanceof InfisicalLoginError &&
		!isCI(env) &&
		!infisicalExportedToken(env)
	);
}

/**
 * Resolve once every site the scopes sign in to through the CLI has a
 * session, or throw the {@link InfisicalLoginError} of one that has none.
 *
 * The token is the one those scopes' fetches use, cached per site, so a run
 * that awaits this before its first container pays no extra CLI process.
 * Other failures (no CLI, a queue on its lock), and a missing session that
 * does not {@link stopsTheRun}, are left to the fetches, which warn about them
 * as before.
 */
export async function ensureSecretsSession(
	scopes: Iterable<InfisicalScope>,
	options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
	const env = options.env ?? process.env;
	const sites = new Map<string, InfisicalScope>();
	for (const scope of scopes)
		if (signsInWithCli(env, scope.siteUrl)) sites.set(scope.siteUrl, scope);

	const wait = anySignal(options.signal, AbortSignal.timeout(LOAD_TIMEOUT_MS));
	await Promise.all(
		[...sites.values()].map(async (scope) => {
			try {
				await cliSessionToken(scope, wait);
			} catch (error) {
				if (stopsTheRun(error, env)) throw error;
				options.signal?.throwIfAborted();
			}
		}),
	);
}

/** Forget every fetched scope. Tests only: a run wants exactly one fetch. */
export function clearScopeSecretsCache(): void {
	cache.clear();
	sessionTokens.clear();
	warnedScopes.clear();
}

/** Warnings belong to consumers; prefetch never reports a failure. */
export function warnSecretsOnce(scope: InfisicalScope, message: string): void {
	const key = scopeKey(scope);
	if (warnedScopes.has(key)) return;
	warnedScopes.add(key);
	console.warn(formatWarn(message));
}

/** A failure as one line, with its fix when there is one. */
export function describeSecretsError(error: unknown): string {
	if (error instanceof SecretsError) {
		return error.fix ? `${error.message} Fix: ${error.fix}` : error.message;
	}
	return getErrorMessage(error);
}

/**
 * Fetch every scope the selected apps name and return each app's own values.
 *
 * Lowest precedence: keys the developer already exported are dropped here, and
 * the caller layers the computed env on top. A failed scope warns once and
 * yields nothing, leaving that app's own loader to do what it does today; a
 * missing or expired session throws instead.
 */
export async function loadAppSecrets(
	apps: Record<string, AppConfig>,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		onWait?: (ms: number) => void;
	} = {},
): Promise<Record<string, Record<string, string>>> {
	const env = options.env ?? process.env;
	const scopes = new Map<string, InfisicalScope>();
	const appScopes = new Map<string, string>();
	for (const [name, app] of Object.entries(apps)) {
		// An app that declared nothing is not opted in, whatever the defaults say.
		if (!app.secrets) continue;
		const scope = resolveScope(app.secrets, undefined, env);
		if (!scope) continue;
		const key = scopeKey(scope);
		scopes.set(key, scope);
		appScopes.set(name, key);
	}
	if (scopes.size === 0) return {};

	const fetched = new Map<string, Record<string, string>>();
	const elapsed = startTimer();
	try {
		await Promise.all(
			[...scopes].map(async ([key, scope]) => {
				try {
					fetched.set(
						key,
						withoutExported(
							await fetchScopeSecrets(scope, { signal: options.signal, env }),
							env,
						),
					);
				} catch (error) {
					options.signal?.throwIfAborted();
					// Every app's own loader would wait on the same login.
					if (stopsTheRun(error, env)) throw error;
					const affected = [...appScopes]
						.filter(([, appKey]) => appKey === key)
						.map(([name]) => name)
						.join(", ");
					warnSecretsOnce(
						scope,
						`Could not load Infisical secrets for ${affected}: ${describeSecretsError(error)} Each app will fetch its own.`,
					);
					fetched.set(key, {});
				}
			}),
		);
	} finally {
		options.onWait?.(elapsed());
	}

	return Object.fromEntries(
		[...appScopes].map(([name, key]) => [name, fetched.get(key) ?? {}]),
	);
}

/** The developer's own exports outrank the project's. */
function withoutExported(
	values: Record<string, string>,
	env: NodeJS.ProcessEnv,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(values).filter(([name]) => env[name] === undefined),
	);
}

/**
 * Every secret in one scope, for something that runs one command with one
 * scope (migrations, seed, `exec`, tasks). Uses the same authentication and
 * per-scope cache as app processes.
 * Throws when the fetch fails.
 */
export async function loadScopeSecrets(
	scope: InfisicalScope,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		onWait?: (ms: number) => void;
	} = {},
): Promise<Record<string, string>> {
	const env = options.env ?? process.env;
	const elapsed = startTimer();
	try {
		return withoutExported(
			await fetchScopeSecrets(scope, { signal: options.signal, env }),
			env,
		);
	} finally {
		options.onWait?.(elapsed());
	}
}

/**
 * `secrets.required` keys an app would start without, per app.
 *
 * Checked against everything the app will actually get: the fetched secrets,
 * the developer's environment and the computed env.
 */
export function missingRequiredSecrets(
	apps: Record<string, AppConfig>,
	provided: (name: string) => Record<string, string | undefined>,
): Record<string, string[]> {
	const missing: Record<string, string[]> = {};
	for (const [name, app] of Object.entries(apps)) {
		const required = app.secrets ? (app.secrets.required ?? []) : [];
		if (required.length === 0) continue;
		const absent = missingKeys(required, provided(name));
		if (absent.length > 0) missing[name] = absent;
	}
	return missing;
}

/**
 * The `required` keys `env` leaves unset or empty: the rule `dev` refuses to
 * start on, and the one `buncargo secrets ls` reports with.
 */
export function missingKeys(
	required: readonly string[],
	env: Record<string, string | undefined>,
): string[] {
	return required.filter((key) => !env[key]);
}
