export interface ComposeCommandContext {
	projectName?: string;
	composeFile?: string;
}

/**
 * Build `-f` argument for docker compose.
 */
export function getComposeArg(composeFile?: string): string {
	return composeFile ? `-f "${composeFile}"` : "";
}

/**
 * Build `docker compose` prefix with optional project and compose file args.
 */
export function getComposeCommandPrefix(
	context: ComposeCommandContext = {},
): string {
	const { projectName, composeFile } = context;
	const composeArg = getComposeArg(composeFile);
	const projectArg = projectName ? `-p ${projectName}` : "";
	return `docker compose ${composeArg} ${projectArg}`.trim();
}
