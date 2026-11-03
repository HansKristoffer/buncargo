/**
 * A secrets failure with its fix. Its own module, free of imports, so the
 * CLI's error reporting can recognise one without loading the fetcher.
 *
 * Never put a secret value, the Infisical CLI's output or a response body in
 * one.
 */
export class SecretsError extends Error {
	constructor(
		message: string,
		readonly fix?: string,
	) {
		super(message);
		this.name = "SecretsError";
	}
}

/**
 * No usable Infisical CLI session: none, an expired one, or a CLI that went
 * for an interactive login. Every fetch on that site fails the same way, so a
 * run stops on it instead of starting apps whose own loaders would hang on the
 * same login.
 *
 * The login command is in the message itself, for a library caller that
 * prints only that; the CLI shows `reason` and `login` on two lines.
 */
export class InfisicalLoginError extends SecretsError {
	readonly login: string;

	constructor(
		readonly reason: string,
		readonly siteUrl: string,
	) {
		const login = infisicalLoginCommand(siteUrl);
		super(`${reason} Run \`${login}\`.`);
		this.name = "InfisicalLoginError";
		this.login = login;
	}
}

/** The one command that fixes an {@link InfisicalLoginError}. */
export function infisicalLoginCommand(siteUrl: string): string {
	return `infisical login --domain=${siteUrl}`;
}
