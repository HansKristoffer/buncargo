import type { AppConfig, SecretsScopeConfig } from "../../types";
import { withFileLock } from "../file-lock";
import {
	connectProcessEnv,
	infisicalMachineCredentials,
	infisicalPathOverride,
	secretsEnvironment,
} from "../runtime-flags";
import { recordStartupMetric } from "../startup-metrics";
import { stateFilePath } from "../state-paths";
import { formatWarn } from "../style";

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
export const DEFAULT_INFISICAL_SITE_URL = "https://eu.infisical.com";

/** One HTTP call or CLI run; only has to outlast a stalled network call. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Every worktree on the machine queues on one lock, so allow a real queue. */
const LOCK_TIMEOUT_MS = 120_000;

export class SecretsError extends Error {
	constructor(
		message: string,
		readonly fix?: string,
	) {
		super(message);
		this.name = "SecretsError";
	}
}

const cache = new Map<string, Promise<Record<string, string>>>();
const warnedScopes = new Set<string>();
const sessionTokens = new Map<string, Promise<string>>();

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
	scope: SecretsScopeConfig | undefined,
	defaults: SecretsScopeConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): InfisicalScope | undefined {
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
		siteUrl: (
			scope?.siteUrl ??
			defaults?.siteUrl ??
			DEFAULT_INFISICAL_SITE_URL
		).replace(/\/+$/, ""),
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
	defaults: SecretsScopeConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): TApps {
	if (!Object.values(apps).some((app) => app.secrets)) return apps;
	return Object.fromEntries(
		Object.entries(apps).map(([name, app]) => [
			name,
			app.secrets
				? {
						...app,
						secrets: {
							...(resolveScope(app.secrets, defaults, env) ?? app.secrets),
							// Not part of the scope's identity, so resolveScope drops it.
							...(app.secrets.required
								? { required: app.secrets.required }
								: {}),
						},
					}
				: app,
		]),
	) as TApps;
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

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
		throw new SecretsError(
			`Infisical ${operation} failed (HTTP ${response.status}).`,
			response.status === 401 || response.status === 403
				? `infisical login --domain=${scope.siteUrl}`
				: undefined,
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
	const token = (value as Record<string, unknown> | null)?.[field];
	if (typeof token !== "string" || !token) {
		throw new SecretsError(`Infisical ${operation} returned no token.`);
	}
	return token;
}

// ─── Authentication ──────────────────────────────────────────────────────────

/** `infisical user get token`, under the machine-wide CLI lock. */
function cliSessionToken(
	scope: InfisicalScope,
	signal: AbortSignal,
): Promise<string> {
	const binary = infisicalPathOverride() ?? "infisical";
	const key = `${scope.siteUrl}|${binary}`;
	const cached = sessionTokens.get(key);
	if (cached) return cached;
	const pending = readCliSessionToken(scope, binary, signal);
	sessionTokens.set(key, pending);
	void pending.catch(() => {
		if (sessionTokens.get(key) === pending) sessionTokens.delete(key);
	});
	return pending;
}

async function readCliSessionToken(
	scope: InfisicalScope,
	binary: string,
	signal: AbortSignal,
): Promise<string> {
	return withFileLock(
		stateFilePath("infisical-cli"),
		async () => {
			recordStartupMetric("subprocesses");
			// Inherited machine tokens would override the signed-in user session.
			const {
				INFISICAL_TOKEN: _token,
				INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: _access,
				...env
			} = connectProcessEnv();
			let child: ReturnType<typeof Bun.spawn>;
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
						// A CLI that decides to prompt must fail, not hold the lock.
						stdin: "ignore",
						stdout: "pipe",
						stderr: "ignore",
						env: { ...env, INFISICAL_DISABLE_UPDATE_CHECK: "true" },
						signal,
					},
				);
			} catch {
				throw new SecretsError(
					"The Infisical CLI is not installed.",
					"brew install infisical/get-cli/infisical",
				);
			}
			const [stdout, exitCode] = await Promise.all([
				new Response(child.stdout as ReadableStream).text(),
				child.exited,
			]);
			signal.throwIfAborted();
			const token = stdout.trim();
			if (exitCode !== 0 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
				// Deliberately without the CLI's stderr, which can contain secrets.
				throw new SecretsError(
					`No Infisical session for ${scope.siteUrl}.`,
					`infisical login --domain=${scope.siteUrl}`,
				);
			}
			return token;
		},
		{ timeoutMs: LOCK_TIMEOUT_MS, signal },
	);
}

/**
 * A session token for the scope's organization. An already scoped session is
 * used as is (no second MFA challenge); the exchanged token stays in memory,
 * so the CLI's persisted session is never switched under another project.
 */
async function scopedSessionToken(
	scope: InfisicalScope,
	signal: AbortSignal,
): Promise<string> {
	const token = await cliSessionToken(scope, signal);
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

export function fetchScopeSecrets(
	scope: InfisicalScope,
	options: {
		signal?: AbortSignal;
		timeoutMs?: number;
		env?: NodeJS.ProcessEnv;
	} = {},
): Promise<Record<string, string>> {
	options.signal?.throwIfAborted();
	const credentials = infisicalMachineCredentials(options.env);
	const key = `${scopeKey(scope)}|${credentials ? "machine" : "session"}`;
	const cached = cache.get(key);
	if (cached) return cached;

	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS * 2;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal
		? AbortSignal.any([options.signal, timeout])
		: timeout;
	const pending = (async () => {
		try {
			const token = credentials
				? await machineToken(scope, credentials, signal)
				: await scopedSessionToken(scope, signal);
			return await listSecrets(scope, token, signal);
		} catch (error) {
			if (timeout.aborted && !options.signal?.aborted) {
				throw new SecretsError(
					`Infisical did not answer within ${timeoutMs}ms.`,
				);
			}
			throw error;
		}
	})();
	cache.set(key, pending);
	// A failure is not cached: the next caller (after `infisical login`) retries.
	// The caller that awaits reports it; this handler also keeps a rejection
	// nobody has awaited yet from tripping the unhandled-rejection handler.
	void pending.catch(() => {
		if (cache.get(key) === pending) cache.delete(key);
	});
	return pending;
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
	return error instanceof Error ? error.message : String(error);
}

/**
 * Fetch every scope the selected apps name and return each app's own values.
 *
 * Lowest precedence: keys the developer already exported are dropped here, and
 * the caller layers the computed env on top. A failed scope warns once and
 * yields nothing, leaving that app's own loader to do what it does today.
 */
export async function loadAppSecrets(
	apps: Record<string, AppConfig>,
	defaults: SecretsScopeConfig | undefined,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		onWait?: (ms: number) => void;
	} = {},
): Promise<Record<string, Record<string, string>>> {
	const env = options.env ?? process.env;
	// A machine identity lets an app's own loader authenticate without the CLI
	// session, whose hang this avoids. Commands still fetch with the identity.
	if (infisicalMachineCredentials(env)) return {};
	const scopes = new Map<string, InfisicalScope>();
	const appScopes = new Map<string, string>();
	for (const [name, app] of Object.entries(apps)) {
		// An app that declared nothing is not opted in, whatever the defaults say.
		if (!app.secrets) continue;
		const scope = resolveScope(app.secrets, defaults, env);
		if (!scope) continue;
		const key = scopeKey(scope);
		scopes.set(key, scope);
		appScopes.set(name, key);
	}
	if (scopes.size === 0) return {};

	const fetched = new Map<string, Record<string, string>>();
	const began = performance.now();
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
		options.onWait?.(performance.now() - began);
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
 * scope (migrations, seed, `exec`, tasks). Unlike app processes,
 * these fetch with a machine identity too: they have no loader of their own.
 * Throws when the scope has no project or the fetch fails.
 */
export async function loadScopeSecrets(
	scope: SecretsScopeConfig,
	options: {
		signal?: AbortSignal;
		env?: NodeJS.ProcessEnv;
		defaults?: SecretsScopeConfig;
		onWait?: (ms: number) => void;
	} = {},
): Promise<Record<string, string>> {
	const env = options.env ?? process.env;
	const resolved = resolveScope(scope, options.defaults, env);
	if (!resolved) {
		throw new SecretsError("The secrets scope has no projectId.");
	}
	const began = performance.now();
	try {
		return withoutExported(
			await fetchScopeSecrets(resolved, { signal: options.signal, env }),
			env,
		);
	} finally {
		options.onWait?.(performance.now() - began);
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
		const required = app.secrets?.required ?? [];
		if (required.length === 0) continue;
		const env = provided(name);
		const absent = required.filter((key) => !env[key]);
		if (absent.length > 0) missing[name] = absent;
	}
	return missing;
}
