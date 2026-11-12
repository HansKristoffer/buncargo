import { isRecord } from "hanzio";
import { infisicalLoginCommand, SecretsError } from "./errors";
import type { InfisicalScope } from "./scope";

/** One HTTP call or CLI run; only has to outlast a stalled network call. */
const REQUEST_TIMEOUT_MS = 30_000;
/** A shared load's ceiling, and every caller's default wait for one. */
export const LOAD_TIMEOUT_MS = REQUEST_TIMEOUT_MS * 2;

/** A refusal Infisical answered, with its status; never its body. */
export class InfisicalRequestError extends SecretsError {
	constructor(
		message: string,
		fix: string | undefined,
		readonly status: number,
	) {
		super(message, fix);
	}
}

/** Whether `error` is Infisical refusing a token it no longer accepts. */
export function isRefusedToken(error: unknown): boolean {
	return error instanceof InfisicalRequestError && error.status === 401;
}

/** One JSON request to the scope's site. Neither a body nor what was sent reaches an error. */
export async function request(
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
	if (status === 401) return infisicalLoginCommand(scope.siteUrl);
	if (status === 403) return organizationFix(scope);
	if (status === 404)
		return `check that project ${scope.projectId} has environment "${scope.environment}" and path "${scope.path}" on ${scope.siteUrl}; a 404 usually means one of them is misspelled or missing.`;
	return undefined;
}

/**
 * A 403 is a session that cannot see the project, most often one scoped to
 * another organization: logging in again changes nothing.
 */
export function organizationFix(scope: InfisicalScope): string {
	return `set secrets.organizationId to the organization project ${scope.projectId} belongs to, or check that this session can access it.`;
}

export function tokenFrom(
	value: unknown,
	field: string,
	operation: string,
): string {
	const token = isRecord(value) ? value[field] : undefined;
	if (typeof token !== "string" || !token) {
		throw new SecretsError(`Infisical ${operation} returned no token.`);
	}
	return token;
}
