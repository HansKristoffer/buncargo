export interface ComposeCommandContext {
	projectName?: string;
	composeFile?: string;
	/** Path to the `docker` binary; defaults to a PATH lookup. */
	binary?: string;
}

/**
 * The `docker compose` prefix as argv.
 *
 * Excludes the binary itself, which the caller hands to `runDocker`. Argv
 * rather than a command line because a compose path or project name is free to
 * contain a space, and there is no shell here to split it.
 */
export function getComposeArgs(context: ComposeCommandContext = {}): string[] {
	const { projectName, composeFile } = context;
	return [
		"compose",
		...(composeFile ? ["-f", composeFile] : []),
		...(projectName ? ["-p", projectName] : []),
	];
}
