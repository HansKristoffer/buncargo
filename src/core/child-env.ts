import { connectProcessEnv } from "./runtime-flags";

/**
 * The environment of a process buncargo starts for the project: an app, a
 * task, `exec`, a migration, the seed, prisma.
 *
 * Never the connect tokens, and never the config's `unsetEnv`: a tool that
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
	const child = connectProcessEnv(env);
	for (const name of unset) delete child[name];
	return child;
}
