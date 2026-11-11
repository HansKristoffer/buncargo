import { anySignal, getErrorMessage, timeoutSignal } from "hanzio";
import { registerAbortCleanup } from "../deadline";
import { formatStep, formatWarn } from "../style";
import {
	clearAuthCache,
	credentialKey,
	machineCredentials,
	sessionOrganization,
	withScopeToken,
} from "./auth";
import { SecretsError } from "./errors";
import {
	InfisicalRequestError,
	LOAD_TIMEOUT_MS,
	organizationFix,
	request,
} from "./http";
import {
	filterScopeKeys,
	folderKey,
	type InfisicalScope,
	scopeKey,
} from "./scope";
import { SharedRequestCache } from "./shared-request";

/**
 * Infisical, fetched once per folder per process, the way hanzio fetches it.
 *
 * Concurrent Infisical CLI processes hang indefinitely (reproduced with four
 * `user get token` calls on 0.41.98), which is what a monorepo does when three
 * apps each run their own loader at startup. So buncargo fetches here and
 * hands the values to the children: their loaders find the keys in
 * `process.env` and never spawn the CLI at all.
 *
 * Values are never logged, never written to a state file, and never put in an
 * error message: neither the CLI's stderr nor a response body is echoed.
 */

const cache = new SharedRequestCache<Record<string, string>>();
const warnedScopes = new Set<string>();
const reportedScopes = new Set<string>();

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
	).catch((error: unknown) => {
		if (!(error instanceof InfisicalRequestError) || error.status !== 403)
			throw error;
		const organization = sessionOrganization(token) ?? "unknown";
		throw new InfisicalRequestError(
			`Infisical refused a session in organization ${organization} access to project ${scope.projectId} (HTTP 403).`,
			organizationFix(scope),
			403,
		);
	})) as {
		secrets?: ListedSecret[];
		imports?: { secrets?: ListedSecret[] }[];
	};

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

/** The scope's secrets, through its `only` and `exclude`. Throws when the fetch fails. */
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
	const credentials = machineCredentials(env, scope.siteUrl);
	const key = `${folderKey(scope)}|${credentialKey(credentials)}`;
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
			return await withScopeToken(scope, credentials, signal, (token) =>
				listSecrets(scope, token, signal),
			);
		},
		waitSignal,
	);
	if (options.signal) registerAbortCleanup(options.signal, pending);
	try {
		return filterScopeKeys(scope, await pending);
	} catch (error) {
		if (timeout.aborted && !options.signal?.aborted)
			throw new SecretsError(`Infisical did not answer within ${timeoutMs}ms.`);
		throw error;
	}
}

/** Forget every fetched scope. Tests only: a run wants exactly one fetch. */
export function clearScopeSecretsCache(): void {
	cache.clear();
	clearAuthCache();
	warnedScopes.clear();
	reportedScopes.clear();
}

/** Whether `scope` is new to `seen`, adding it. */
function firstTime(seen: Set<string>, scope: InfisicalScope): boolean {
	const key = scopeKey(scope);
	if (seen.has(key)) return false;
	seen.add(key);
	return true;
}

/** Warnings belong to consumers; prefetch never reports a failure. */
export function warnSecretsOnce(scope: InfisicalScope, message: string): void {
	if (firstTime(warnedScopes, scope)) console.warn(formatWarn(message));
}

/**
 * Print `line` the first time `scope` is reported in this process. A start
 * loads its apps' secrets more than once (the required-keys check, then the
 * spawn); the developer reads about each scope once.
 */
export function reportScopeOnce(
	scope: InfisicalScope,
	line: string,
	options: { warn?: boolean } = {},
): void {
	if (!firstTime(reportedScopes, scope)) return;
	if (options.warn) console.warn(formatWarn(line));
	else console.log(formatStep(line));
}

/** A failure as one line, with its fix when there is one. */
export function describeSecretsError(error: unknown): string {
	if (error instanceof SecretsError) {
		return error.fix ? `${error.message} Fix: ${error.fix}` : error.message;
	}
	return getErrorMessage(error);
}
