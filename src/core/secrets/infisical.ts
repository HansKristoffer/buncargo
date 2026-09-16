import type { AppConfig, SecretsScopeConfig } from "../../types";
import { withFileLock } from "../file-lock";
import {
	connectProcessEnv,
	infisicalPathOverride,
	secretsEnvironment,
} from "../runtime-flags";
import { recordStartupMetric } from "../startup-metrics";
import { stateFilePath } from "../state-paths";
import { formatWarn } from "../style";

/**
 * One `infisical export` per distinct scope per dev run, never two at once.
 *
 * Concurrent Infisical CLI processes hang indefinitely (reproduced with four
 * `user get token` calls on 0.41.98), which is what a monorepo does when three
 * apps each run their own `defineSecretSet` loader at startup. Fetching here
 * and handing the values to the children means their loaders find the keys in
 * `process.env` and never spawn the CLI at all.
 *
 * Values are never logged, never written to a state file, and never put in an
 * error message: the CLI's own stderr can carry secret material.
 */

export interface InfisicalScope {
	projectId: string;
	environment: string;
	siteUrl: string;
	/** Folder, matching hanzio's secretPath. Default "/". */
	path: string;
}

/** A single export is ~1s; this only has to be longer than a stalled network call. */
const EXPORT_TIMEOUT_MS = 30_000;
/** Every worktree on the machine queues on one lock, so allow a real queue. */
const LOCK_TIMEOUT_MS = 120_000;

const DEFAULT_SITE_URL = "https://app.infisical.com";

/**
 * A machine identity in the environment means the app's own loader can
 * authenticate without the interactive CLI session this module drives, and the
 * hang it exists to avoid needs that session. Leave those runs alone.
 */
function usesMachineIdentity(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env.INFISICAL_CLIENT_ID && env.INFISICAL_CLIENT_SECRET);
}

/** Cache + machine-wide serialization: one CLI process at a time, one per scope per run. */
const cache = new Map<string, Promise<Record<string, string>>>();

export function scopeKey(scope: InfisicalScope): string {
	return `${scope.siteUrl}|${scope.projectId}|${scope.environment}|${scope.path}`;
}

/**
 * Resolve an app's scope against the config-level defaults.
 *
 * Returns undefined when no project id is in reach, which is how an app that
 * declared nothing keeps today's behaviour.
 */
export function resolveScope(
	app: SecretsScopeConfig | undefined,
	defaults: SecretsScopeConfig | undefined,
	env: NodeJS.ProcessEnv = process.env,
): InfisicalScope | undefined {
	const projectId = app?.projectId ?? defaults?.projectId;
	if (!projectId) return undefined;
	return {
		projectId,
		environment:
			app?.environment ??
			defaults?.environment ??
			secretsEnvironment(env) ??
			"dev",
		siteUrl: app?.siteUrl ?? defaults?.siteUrl ?? DEFAULT_SITE_URL,
		path: app?.path ?? defaults?.path ?? "/",
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
						secrets: resolveScope(app.secrets, defaults, env) ?? app.secrets,
					}
				: app,
		]),
	) as TApps;
}

export function fetchScopeSecrets(
	scope: InfisicalScope,
	options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Record<string, string>> {
	const key = scopeKey(scope);
	const cached = cache.get(key);
	if (cached) return cached;
	const pending = runExport(scope, options);
	// The caller that awaits reports the failure; this only keeps a rejection
	// that nobody has awaited yet from tripping the unhandled-rejection handler.
	pending.catch(() => {});
	cache.set(key, pending);
	return pending;
}

/** Forget every fetched scope. Tests only: a dev run wants exactly one fetch. */
export function clearScopeSecretsCache(): void {
	cache.clear();
}

async function runExport(
	scope: InfisicalScope,
	options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, string>> {
	const timeoutMs = options.timeoutMs ?? EXPORT_TIMEOUT_MS;
	const binary = infisicalPathOverride() ?? "infisical";
	return withFileLock(
		stateFilePath("infisical-cli"),
		async () => {
			const timeout = AbortSignal.timeout(timeoutMs);
			const signal = options.signal
				? AbortSignal.any([options.signal, timeout])
				: timeout;
			recordStartupMetric("subprocesses");
			const child = Bun.spawn(
				[
					binary,
					"export",
					"--format=json",
					"--silent",
					`--projectId=${scope.projectId}`,
					`--env=${scope.environment}`,
					`--path=${scope.path}`,
					`--domain=${scope.siteUrl}`,
				],
				{
					// A CLI that decides to prompt must fail, not hold the lock.
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
					env: connectProcessEnv(),
					signal,
				},
			);
			const [stdout, exitCode] = await Promise.all([
				new Response(child.stdout).text(),
				child.exited,
			]);
			if (exitCode !== 0) {
				options.signal?.throwIfAborted();
				// Deliberately without the CLI's stderr, which can contain secrets.
				throw new Error(
					timeout.aborted
						? `infisical export timed out after ${timeoutMs}ms`
						: `infisical export exited with code ${exitCode}`,
				);
			}
			return parseExport(stdout);
		},
		{ timeoutMs: LOCK_TIMEOUT_MS, signal: options.signal },
	);
}

/** `--format=json` is an array of `{key, value}` records; older CLIs emit an object. */
function parseExport(stdout: string): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error("infisical export did not return JSON");
	}
	const values: Record<string, string> = {};
	if (Array.isArray(parsed)) {
		for (const entry of parsed) {
			if (typeof entry !== "object" || entry === null) continue;
			const { key, value } = entry as { key?: unknown; value?: unknown };
			// An empty value would satisfy the app loader's "already in the
			// environment" check and hand the app a blank secret. Leave the key
			// missing instead, so its own loader still fetches and still fails
			// loudly if the project really has nothing there.
			if (typeof key === "string" && key && typeof value === "string" && value)
				values[key] = value;
		}
		return values;
	}
	if (typeof parsed === "object" && parsed !== null) {
		for (const [key, value] of Object.entries(parsed))
			if (typeof value === "string" && value) values[key] = value;
		return values;
	}
	throw new Error("infisical export returned an unexpected shape");
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
	options: { signal?: AbortSignal; env?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, Record<string, string>>> {
	const env = options.env ?? process.env;
	if (usesMachineIdentity(env)) return {};
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
	await Promise.all(
		[...scopes].map(async ([key, scope]) => {
			try {
				fetched.set(
					key,
					// The developer's own exports outrank the project's.
					Object.fromEntries(
						Object.entries(
							await fetchScopeSecrets(scope, { signal: options.signal }),
						).filter(([name]) => env[name] === undefined),
					),
				);
			} catch (error) {
				const affected = [...appScopes]
					.filter(([, appKey]) => appKey === key)
					.map(([name]) => name)
					.join(", ");
				console.warn(
					formatWarn(
						`Could not load Infisical secrets for ${affected}: ${error instanceof Error ? error.message : String(error)}. Each app will fetch its own; run \`infisical login\` if they fail too.`,
					),
				);
				fetched.set(key, {});
			}
		}),
	);

	return Object.fromEntries(
		[...appScopes].map(([name, key]) => [name, fetched.get(key) ?? {}]),
	);
}
