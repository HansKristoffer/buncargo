import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { anySignal, timeoutSignal } from "hanzio";
import { connectProcessEnv } from "../child-env";
import { withFileLock } from "../file-lock";
import {
	infisicalExportedToken,
	infisicalMachineCredentials,
	infisicalPathOverride,
	infisicalUniversalAuthFile,
	isCI,
} from "../runtime-flags";
import { recordStartupMetric } from "../startup-metrics";
import { resolveUserHome, stateFilePath } from "../state-paths";
import { InfisicalLoginError, SecretsError } from "./errors";
import { isRefusedToken, LOAD_TIMEOUT_MS, request, tokenFrom } from "./http";
import type { InfisicalScope } from "./scope";
import { SharedRequestCache } from "./shared-request";

/**
 * How buncargo signs in to Infisical: the user's CLI session (asked under a
 * machine-wide lock, never as an interactive login), or a universal-auth
 * identity. Tokens are cached per site and credential, so N scopes on one
 * site cost one sign-in and N lists.
 */

/**
 * `infisical user get token` once it holds the lock: a local read and one
 * `checkAuth` round trip, well under a second. Bounds a CLI waiting silently
 * on a login nobody will finish; a login prompt it prints ends it at once.
 */
const CLI_TIMEOUT_MS = 2_000;
/**
 * Every worktree on the machine queues on one lock, so allow a real queue:
 * all of the load's ceiling but the CLI run, so a long queue ends in the
 * lock's own error, which names it, rather than a generic "did not answer".
 */
const LOCK_TIMEOUT_MS = LOAD_TIMEOUT_MS - CLI_TIMEOUT_MS;
/**
 * How long a site found unreachable stays so. A start asks for the session
 * more than once (the session check, then the fetches); offline, each ask
 * would wait out the CLI and the probe again.
 */
const UNREACHABLE_FOR_MS = 30_000;

export type MachineCredentials = NonNullable<
	ReturnType<typeof infisicalMachineCredentials>
>;

/**
 * The machine identity hanzio also reads when the environment names none:
 * `~/.infisical/universal-auth.json` (`INFISICAL_UNIVERSAL_AUTH_FILE` overrides
 * it), which agentgate keeps on every machine. Only used for its own instance.
 */
function identityFile(
	env: NodeJS.ProcessEnv,
	siteUrl: string,
): MachineCredentials | undefined {
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

/** The identity `siteUrl` is reached with, or undefined for the user's CLI session. */
export function machineCredentials(
	env: NodeJS.ProcessEnv,
	siteUrl: string,
): MachineCredentials | undefined {
	return infisicalMachineCredentials(env) ?? identityFile(env, siteUrl);
}

/**
 * What tells one sign-in from another, for cache keys: the CLI session, or a
 * hash of the identity, so a rotated credential authenticates for itself and
 * no raw credential sits in a key.
 */
export function credentialKey(
	credentials: MachineCredentials | undefined,
): string {
	return credentials
		? createHash("sha256").update(JSON.stringify(credentials)).digest("hex")
		: "session";
}

const sessionTokens = new SharedRequestCache<string>();
const machineTokens = new SharedRequestCache<string>();
/** Sites the CLI could not check a session on, until when. */
const unreachableUntil = new Map<string, number>();

/** Forget every token and unreachable site. */
export function clearAuthCache(): void {
	sessionTokens.clear();
	machineTokens.clear();
	unreachableUntil.clear();
}

/**
 * Run `use` with a token for the scope: the identity's, else the CLI
 * session's, scoped to the scope's organization. Tokens are cached for the
 * process, so a long run's later scopes would keep sending one Infisical
 * stopped accepting (expired, or a logout elsewhere): on its 401 the token is
 * forgotten and asked for once more.
 */
export async function withScopeToken<T>(
	scope: InfisicalScope,
	credentials: MachineCredentials | undefined,
	signal: AbortSignal,
	use: (token: string) => Promise<T>,
): Promise<T> {
	const token = () =>
		credentials
			? machineToken(scope, credentials, signal)
			: cliSessionToken(scope, signal);
	const scoped = async (raw: string) =>
		credentials ? raw : scopedSessionToken(scope, raw, signal);
	const first = await token();
	try {
		return await use(await scoped(first));
	} catch (error) {
		if (!isRefusedToken(error)) throw error;
		if (credentials)
			machineTokens.forget(machineKey(scope, credentials), first);
		else sessionTokens.forget(cliSessionKey(scope), first);
	}
	return use(await scoped(await token()));
}

// ─── Universal auth ──────────────────────────────────────────────────────────

const machineKey = (scope: InfisicalScope, credentials: MachineCredentials) =>
	`${scope.siteUrl}|${credentialKey(credentials)}`;

/** One universal-auth login per site and identity, shared by every scope. */
function machineToken(
	scope: InfisicalScope,
	credentials: MachineCredentials,
	signal: AbortSignal,
): Promise<string> {
	return machineTokens.get(
		machineKey(scope, credentials),
		async (sharedSignal) =>
			tokenFrom(
				await request(
					scope,
					"universal-auth login",
					"/api/v1/auth/universal-auth/login",
					{
						method: "POST",
						body: JSON.stringify(credentials),
						signal: timeoutSignal(LOAD_TIMEOUT_MS, sharedSignal),
					},
				),
				"accessToken",
				"universal-auth login",
			),
		signal,
	);
}

// ─── CLI session ─────────────────────────────────────────────────────────────

const cliBinary = () => infisicalPathOverride() ?? "infisical";

const cliSessionKey = (scope: InfisicalScope) =>
	`${scope.siteUrl}|${cliBinary()}`;

/** `infisical user get token`, under the machine-wide CLI lock. */
function cliSessionToken(
	scope: InfisicalScope,
	signal: AbortSignal,
): Promise<string> {
	const until = unreachableUntil.get(scope.siteUrl);
	if (until !== undefined && Date.now() < until)
		return Promise.reject(unreachableError(scope));
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

/**
 * A CLI that timed out or failed without asking for a login: an expired
 * session, or a network that never let it check. {@link readCliSessionToken}
 * tells the two apart.
 */
class UnconfirmedLoginError extends InfisicalLoginError {}

function unreachableError(scope: InfisicalScope): SecretsError {
	return new SecretsError(
		`Infisical at ${scope.siteUrl} is unreachable (offline, or an outage), so the CLI could not check its session.`,
	);
}

/** Whether `siteUrl` answers at all; any HTTP status counts. No credentials. */
async function reachable(scope: InfisicalScope): Promise<boolean> {
	try {
		await fetch(`${scope.siteUrl}/api/status`, {
			headers: { "user-agent": "buncargo" },
			signal: AbortSignal.timeout(CLI_TIMEOUT_MS),
		});
		return true;
	} catch {
		return false;
	}
}

async function readCliSessionToken(
	scope: InfisicalScope,
	binary: string,
	signal: AbortSignal,
): Promise<string> {
	try {
		return await withFileLock(
			stateFilePath("infisical-cli"),
			() => runCliSessionToken(scope, binary, signal),
			{ timeoutMs: LOCK_TIMEOUT_MS, signal },
		);
	} catch (error) {
		// Probed after the lock is released: other worktrees queue on it.
		if (error instanceof UnconfirmedLoginError && !(await reachable(scope))) {
			unreachableUntil.set(scope.siteUrl, Date.now() + UNREACHABLE_FOR_MS);
			throw unreachableError(scope);
		}
		throw error;
	}
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
		throw new UnconfirmedLoginError(
			`The Infisical CLI did not answer within ${CLI_TIMEOUT_MS / 1000}s for ${scope.siteUrl}: an expired session waits there on a login. If you are logged in, it was slow (the network, or a keychain prompt to allow): run the command again.`,
			scope.siteUrl,
		);
	// Deliberately without the CLI's output, which can contain secrets.
	if (exitCode !== 0)
		throw new UnconfirmedLoginError(
			`No Infisical session for ${scope.siteUrl}.`,
			scope.siteUrl,
		);
	const token = (await stdout).trim();
	if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
		throw new InfisicalLoginError(
			`No Infisical session for ${scope.siteUrl}.`,
			scope.siteUrl,
		);
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

// ─── Session checks ──────────────────────────────────────────────────────────

/** Whether `siteUrl` is reached with the user's CLI session, not an identity. */
function signsInWithCli(env: NodeJS.ProcessEnv, siteUrl: string): boolean {
	try {
		return !machineCredentials(env, siteUrl);
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
 * Other failures (no CLI, a queue on its lock, an unreachable site), and a
 * missing session that does not {@link stopsTheRun}, are left to the fetches,
 * which warn about them as before.
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
