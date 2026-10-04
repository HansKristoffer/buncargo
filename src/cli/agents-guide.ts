import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What an AI agent working in a buncargo checkout should know.
 *
 * `buncargo help agents` prints it, and `buncargo setup --agents` keeps a short
 * block in the project's `AGENTS.md` that points here. It lives in code rather
 * than in `docs/` so the copy an agent reads is always the installed version's.
 *
 * Every line answers something agents got wrong in real sessions: polling with
 * `sleep`, `nohup … & disown`, grepping the compose file for credentials,
 * `docker exec` into another worktree's database, `dev --reset` to "fix" a
 * migration.
 */
export const AGENTS_GUIDE = `# buncargo for agents

This checkout runs its services (databases, caches) and apps (dev servers)
through buncargo. Every worktree gets its own ports, containers and URLs: never
reuse a port, container, database or URL from another checkout, and never
hardcode a port. Ask buncargo instead.

## Start and stop

- \`bunx buncargo dev --detach\` starts the run in the background and returns once
  every app is up. Exit 1 names the apps that did not come up; the others keep
  running. Do not use \`nohup\`, \`&\` or \`disown\`.
- \`bunx buncargo dev --detach --apps=api\` starts only some apps (and the apps
  they require). \`--profile=<name>\` picks a configured set.
- \`bunx buncargo stop --all --force\` stops this checkout's run (without a
  terminal it refuses unless \`--force\` says the run is yours to stop).
  \`bunx buncargo stop <app>\` stops one app and \`bunx buncargo restart <app>\`
  restarts one.
- An app already running in another terminal is reused, not started twice.

## Readiness

- \`bunx buncargo wait --app=<app>\` blocks until the app is healthy (exit 0),
  failed (1) or timed out (2). Use it instead of \`sleep\` or \`curl\` loops.

## Reading the environment

- \`bunx buncargo url <app>\` prints the URL to open.
- \`bunx buncargo env --get DATABASE_URL\` prints any variable the apps get, and
  \`bunx buncargo env --get ports.<name>\` one port.
  \`eval "$(bunx buncargo env --export)"\` loads them all into a shell.
- \`bunx buncargo status --json\` is ports, containers, URLs and app states as one
  object.
- \`bunx buncargo exec -- <command>\` runs a command with this checkout's
  environment. \`bunx buncargo run <task>\` runs a configured task;
  \`bunx buncargo help\` lists them.

## Logs

- \`bunx buncargo logs <app> --errors\`, \`--since=5m\`, \`-f\`. App output is kept
  per run, so it is there after the terminal scrolled or the run ended.

## Databases

- \`bunx buncargo sql\` opens the database's own client in this checkout's
  container. \`bunx buncargo sql -c "select …" --json\` runs one query and prints
  the rows as JSON. \`bunx buncargo sql redis -c "GET key"\` works for Redis.
- Do not \`docker exec\` into a database by name or read credentials from the
  generated compose file: other worktrees run databases of their own.

## Do not

- \`dev --reset\` deletes this checkout's database and \`dev --down --all\` stops
  every checkout's run. Both refuse without a terminal unless \`--yes\` is
  passed. Pass it only when the user asked for exactly that.
- Do not edit \`.buncargo/\` or the generated compose file.

## When something fails

- \`bunx buncargo doctor\` checks Docker, ports, named hosts and leftovers.
- \`bunx buncargo setup --yes\` runs the fix of every failing check (missing
  dependencies, generated files).
- A port "held by an unidentified process" is usually a system service. Run
  \`dev\` again: buncargo moves the checkout to a free port block.
`;

const BLOCK_START = "<!-- buncargo:start -->";
const BLOCK_END = "<!-- buncargo:end -->";

/** The block `setup --agents` keeps in AGENTS.md: short, pointing at the guide. */
export const AGENTS_BLOCK = `${BLOCK_START}
## Dev environment (buncargo)

Services and dev servers run through buncargo, with ports, containers and URLs
of their own per worktree. Run \`bunx buncargo help agents\` before starting,
stopping or querying anything. In short:

- Start: \`bunx buncargo dev --detach\` (returns once apps are up). Stop: \`bunx buncargo stop --all --force\`.
- Wait: \`bunx buncargo wait --app=<app>\`. Logs: \`bunx buncargo logs <app> --errors\`.
- Values: \`bunx buncargo env --get DATABASE_URL\`, \`bunx buncargo url <app>\`, \`bunx buncargo status --json\`.
- Database: \`bunx buncargo sql -c "<query>" --json\`.
- Never \`dev --reset\` or \`dev --down --all\` unless asked.
${BLOCK_END}`;

/** `content` with the buncargo block replaced, or appended when it has none. */
export function upsertAgentsBlock(content: string): string {
	const start = content.indexOf(BLOCK_START);
	const end = content.indexOf(BLOCK_END);
	if (start !== -1 && end > start)
		return `${content.slice(0, start)}${AGENTS_BLOCK}${content.slice(end + BLOCK_END.length)}`;
	if (!content.trim()) return `${AGENTS_BLOCK}\n`;
	return `${content.trimEnd()}\n\n${AGENTS_BLOCK}\n`;
}

/** Write the block into `<root>/AGENTS.md`. Returns whether the file changed. */
export function writeAgentsBlock(root: string): {
	path: string;
	changed: boolean;
} {
	const path = join(root, "AGENTS.md");
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const next = upsertAgentsBlock(current);
	if (next !== current) writeFileSync(path, next);
	return { path, changed: next !== current };
}
