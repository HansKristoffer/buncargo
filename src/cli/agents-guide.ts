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
- \`bunx buncargo stop --all\` stops this checkout's run. A run someone started
  in a terminal (not with \`--detach\`) asks first, and without a terminal needs
  \`--force\`: only stop that one when the user asked.
  \`bunx buncargo stop <app>\` stops one app and \`bunx buncargo restart <app>\`
  restarts one.
- An app already running in another terminal is reused, not started twice.
- An interactive app (Expo) runs in a terminal of its own when you have none.
  Press its keys with \`bunx buncargo send <app> <keys>\`, e.g.
  \`bunx buncargo send expoApp i\` to open the iOS simulator. Do not wrap it in
  \`script\` or \`tail -f /dev/null\`.
- Apps with a \`watch\` config restart themselves when their files change; do
  not run them under \`bun --watch\` as well.

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

## Checks

- \`bunx buncargo typecheck --changed\` checks the workspaces this branch
  touched and the ones depending on them.
- Typechecks share a few slots across every checkout on the machine. One that
  says it is waiting for a slot is not stuck; let it wait.
- Run test suites as \`bunx buncargo exec --slot -- <command>\` so they take
  a slot too.

## Logs

- \`bunx buncargo logs <app> --errors\`, \`--since=5m\`, \`-f\`. App output is kept
  per run, so it is there after the terminal scrolled or the run ended.

## Databases

- \`bunx buncargo sql\` opens the database's own client in this checkout's
  container. \`bunx buncargo sql -c "select …" --json\` runs one query and prints
  the rows as JSON. \`bunx buncargo sql redis -c "GET key"\` works for Redis.
- For a throwaway database (a migration check, a test run), use
  \`DATABASE_URL=$(bunx buncargo sql --create-scratch=<name>) <command>\`: an
  empty \`scratch_<name>\` in this checkout's Postgres, recreated each time.
  \`bunx buncargo sql --drop-scratch=<name>\` removes it. Do not \`docker run\`
  a Postgres of your own.
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
- Each checkout keeps its port offset (\`bunx buncargo ports\`). Do not set
  \`BUNCARGO_PORT_OFFSET\` or edit \`.buncargo/ports.json\`; to move a checkout,
  \`bunx buncargo ports pin <offset>\`.
- Docker out of disk, or hanging: \`bunx buncargo prune --project --dry-run\`
  lists this project's leftover \`ci\` stacks and deleted worktrees' stacks.
  Removing them deletes their data, so ask before running it without
  \`--dry-run\`. It never touches an existing checkout's dev database.

## Changing dev.config.ts

- Housekeeping that needs the database before any app starts (unlocking stale
  jobs, resetting a queue) goes in \`hooks.afterContainersReady\`: it runs on
  every start, after migrations and before the apps. \`preflight\` runs before
  the containers start, so the database is not up yet there.
- Tools that change behaviour in an agent's shell can be kept from seeing it with
  \`unsetEnv: ["VAR", …]\`, which removes those variables from every process
  buncargo starts.
`;

const BLOCK_START = "<!-- buncargo:start -->";
const BLOCK_END = "<!-- buncargo:end -->";

/** The block `setup --agents` keeps in AGENTS.md: short, pointing at the guide. */
export const AGENTS_BLOCK = `${BLOCK_START}
## Dev environment (buncargo)

Services and dev servers run through buncargo, with ports, containers and URLs
of their own per worktree. Run \`bunx buncargo help agents\` before starting,
stopping or querying anything. In short:

- Start: \`bunx buncargo dev --detach\` (returns once apps are up). Stop: \`bunx buncargo stop --all\`.
- Wait: \`bunx buncargo wait --app=<app>\`. Logs: \`bunx buncargo logs <app> --errors\`.
- Values: \`bunx buncargo env --get DATABASE_URL\`, \`bunx buncargo url <app>\`, \`bunx buncargo status --json\`.
- Database: \`bunx buncargo sql -c "<query>" --json\`; a throwaway one: \`bunx buncargo sql --create-scratch=<name>\`.
- Keys for Expo and other interactive apps: \`bunx buncargo send <app> <keys>\`.
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
