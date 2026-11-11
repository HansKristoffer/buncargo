import { CONNECT_TOKENS_ENV, DETACHED_ENV } from "./runtime-flags";

/**
 * The environment of buncargo's own tools: the connect coordinator, frpc,
 * cloudflared, infisical. Everything but the connect tokens.
 */
export function connectProcessEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const { [CONNECT_TOKENS_ENV]: _tokens, ...rest } = env;
	return rest;
}

/**
 * The environment of a process buncargo starts for the project: an app, a
 * task, `exec`, a migration, the seed.
 *
 * Never the connect tokens, never the detached run's mark, and never the
 * config's `unsetEnv`: a tool that
 * changes behaviour when it sees an agent's shell (Astro detaches) is spared
 * the variables it reads, without the project deleting them from buncargo's
 * own `process.env` in `dev.config.ts`. Module state because the config is
 * read once per process and every spawn point reaches here.
 */
let unset: readonly string[] = [];

export function setUnsetEnv(names: readonly string[] | undefined): void {
	unset = names ?? [];
}

export function childProcessEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const child = agentAwareProcessEnv(env);
	for (const name of unset) delete child[name];
	return child;
}

/**
 * {@link childProcessEnv} with the config's `unsetEnv` left in, for a tool
 * whose own agent detection is a guard: the Prisma CLI refuses a destructive
 * Migrate action in an agent's shell by the very variables (`CLAUDECODE`)
 * projects unset for their dev servers.
 */
export function agentAwareProcessEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const child = connectProcessEnv(env);
	// A detached run's own mark: a `buncargo dev` an app starts is not that run.
	delete child[DETACHED_ENV];
	return child;
}
