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
} from "../runtime-flags";
import { recordStartupMetric } from "../startup-metrics";
import { resolveUserHome, stateFilePath } from "../state-paths";
import {
	InfisicalLoginError,
	infisicalLoginCommand,
	SecretsError,
} from "./errors";
import {
	InfisicalRequestError,
	isRefusedToken,
	LOAD_TIMEOUT_MS,
	request,
	tokenFrom,
} from "./http";
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
const scopedSessionTokens = new SharedRequestCache<string>();
const loginOrgListings = new SharedRequestCache<LoginOrganization[]>();
/** Sites the CLI could not check a session on, until when. */
const unreachableUntil = new Map<string, number>();

/**
 * The organization found to own a project, by site and project, for a login
 * that spans several and a scope that names none.
 */
const owningOrganizations = new Map<string, string>();
const projectKey = (scope: InfisicalScope) =>
	`${scope.siteUrl}|${scope.projectId}`;

/** Forget every token, unreachable site and owning organization. */
export function clearAuthCache(): void {
	sessionTokens.clear();
	machineTokens.clear();
	scopedSessionTokens.clear();
	loginOrgListings.clear();
	unreachableUntil.clear();
	owningOrganizations.clear();
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
	// Named on the scope, else the one an earlier scope found to own the project.
	const organizationId =
		scope.organizationId ?? owningOrganizations.get(projectKey(scope));
	const scoped = async (raw: string) =>
		credentials
			? raw
			: scopedSessionToken({ ...scope, organizationId }, raw, signal);
	let lastScoped: { key: string; value: string } | undefined;
	const attempt = async (raw: string) => {
		const resolvedToken = await scoped(raw);
		if (!credentials && organizationId && resolvedToken !== raw) {
			lastScoped = {
				key: `${scope.siteUrl}|${organizationId}|${raw}`,
				value: resolvedToken,
			};
		}
		try {
			return await use(resolvedToken);
		} catch (error) {
			// An identity belongs to one organization; a named one is the developer's word.
			if (credentials || organizationId || !isRefusedProject(error))
				throw error;
			return useInOwningOrganization(scope, raw, signal, use, error);
		}
	};
	const first = await token();
	try {
		return await attempt(first);
	} catch (error) {
		if (!isRefusedToken(error)) throw error;
		if (lastScoped) {
			scopedSessionTokens.forget(lastScoped.key, lastScoped.value);
		}
		if (credentials)
			machineTokens.forget(machineKey(scope, credentials), first);
		else sessionTokens.forget(cliSessionKey(scope), first);
	}
	return attempt(await token());
}

function isRefusedProject(error: unknown): error is InfisicalRequestError {
	return error instanceof InfisicalRequestError && error.status === 403;
}

/** An organization of the login, as `GET /api/v1/organization` lists it. */
interface LoginOrganization {
	readonly id: string;
	readonly name: string;
}

/** Every organization the session's user belongs to, whichever one the session is scoped to. */
async function loginOrganizations(
	scope: InfisicalScope,
	token: string,
	signal: AbortSignal,
): Promise<LoginOrganization[]> {
	return loginOrgListings.get(
		`${scope.siteUrl}|${token}`,
		async (sharedSignal) => {
			const data = (await request(
				scope,
				"list organizations",
				"/api/v1/organization",
				{
					method: "GET",
					headers: { authorization: `Bearer ${token}` },
					signal: timeoutSignal(LOAD_TIMEOUT_MS, sharedSignal),
				},
			)) as { organizations?: { id?: unknown; name?: unknown }[] };
			return (data?.organizations ?? []).flatMap(({ id, name }) =>
				typeof id === "string" && id
					? [{ id, name: typeof name === "string" && name ? name : id }]
					: [],
			);
		},
		signal,
	);
}

/**
 * `use` in the organization that owns the scope's project, when the CLI
 * session's own organization was refused it (`refusal`) and the login spans
 * others: each is tried in turn, and the one that answers is remembered for
 * the project's other scopes. A login with no other organization, or a site
 * that will not list them, gets `refusal` back unchanged.
 */
async function useInOwningOrganization<T>(
	scope: InfisicalScope,
	raw: string,
	signal: AbortSignal,
	use: (token: string) => Promise<T>,
	refusal: InfisicalRequestError,
): Promise<T> {
	const current = sessionOrganization(raw);
	const organizations = await loginOrganizations(scope, raw, signal).catch(
		() => [],
	);
	const others = organizations.filter(({ id }) => id !== current);
	if (others.length === 0) throw refusal;

	const needMfa: string[] = [];
	const wontExchange: string[] = [];
	for (const organization of others) {
		let token: string;
		try {
			token = await scopedSessionToken(
				{ ...scope, organizationId: organization.id },
				raw,
				signal,
			);
		} catch (error) {
			if (error instanceof MfaRequiredError) needMfa.push(organization.name);
			else if (refusesExchange(error)) wontExchange.push(organization.name);
			else throw error;
			continue;
		}

		try {
			const result = await use(token);
			owningOrganizations.set(projectKey(scope), organization.id);
			return result;
		} catch (error) {
			if (!isRefusedProject(error)) throw error;
		}
	}

	// The session's own refusal says why; the rest says where else was tried.
	const names = others.map(({ name }) => name).join(", ");
	const message = `${refusal.message} The login's other organizations (${names}) could not read it either.`;
	const login = infisicalLoginCommand(scope.siteUrl);
	const blocked = [...needMfa, ...wontExchange];
	const fix =
		blocked.length > 0
			? `${login} and pick ${blocked.join(" or ")}, which would not take this session (MFA, SSO or a policy), or set secrets.organizationId to the organization that owns project ${scope.projectId}.`
			: `check that this login can read environment "${scope.environment}" and path "${scope.path}" of project ${scope.projectId}, or ask for access to it.`;
	throw new InfisicalRequestError(message, fix, 403);
}

/** An organization that refused to exchange the session (not an expired token: that retries). */
function refusesExchange(error: unknown): boolean {
	return (
		error instanceof InfisicalRequestError &&
		error.status >= 400 &&
		error.status < 500 &&
		error.status !== 401
	);
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
					BROWSER: "false",
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
				(line.includes(" ") &&
					/login|log in|sign in|authenticate|email|browser|expired/i.test(
						line,
					)) ||
				/https?:\/\/localhost[:/]/.test(line),
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

/** An organization that will not exchange the session without an MFA login. */
class MfaRequiredError extends SecretsError {}

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
	const organizationId = scope.organizationId;
	return scopedSessionTokens.get(
		`${scope.siteUrl}|${organizationId}|${token}`,
		async (sharedSignal) => {
			const data = (await request(
				scope,
				"select-organization",
				"/api/v3/auth/select-organization",
				{
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({ organizationId }),
					signal: timeoutSignal(LOAD_TIMEOUT_MS, sharedSignal),
				},
			)) as { isMfaEnabled?: unknown };
			if (data?.isMfaEnabled) {
				throw new MfaRequiredError(
					"Infisical requires MFA for this organization.",
					`${infisicalLoginCommand(scope.siteUrl)} (and pick the organization)`,
				);
			}
			const scoped = tokenFrom(data, "token", "select-organization");
			if (sessionOrganization(scoped) !== organizationId) {
				throw new SecretsError(
					"Infisical returned a session for a different organization.",
				);
			}
			return scoped;
		},
		signal,
	);
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
 * Whether `error` stops a run rather than warning: a missing or expired CLI
 * session, unless the shell exports its own token for apps' loaders. Applies
 * in headless/non-TTY shells and CI too, so expired auth fails fast with
 * `INFISICAL_AUTH_EXPIRED` instead of letting apps spawn a hanging browser
 * login.
 */
export function stopsTheRun(
	error: unknown,
	env: NodeJS.ProcessEnv = process.env,
): error is InfisicalLoginError {
	return error instanceof InfisicalLoginError && !infisicalExportedToken(env);
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
	const checkedSites = new Set<string>();
	for (const scope of scopes) {
		if (checkedSites.has(scope.siteUrl)) continue;
		checkedSites.add(scope.siteUrl);
		if (signsInWithCli(env, scope.siteUrl)) sites.set(scope.siteUrl, scope);
	}
	if (sites.size === 0) return;

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
