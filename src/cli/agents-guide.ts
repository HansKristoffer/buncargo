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
  running. Exit 0 also when every app was already running and is reused. Do
  not use \`nohup\`, \`&\` or \`disown\`.
- \`bunx buncargo dev --detach --apps=api\` starts only some apps (and the apps
  they require). \`--profile=<name>\` picks a configured set.
- \`bunx buncargo stop --all\` stops this checkout's run, and removes the
  containers an ended run left waiting out its idle hold. A run someone started
  in a terminal (not with \`--detach\`) asks first, and without a terminal needs
  \`--force\`: only stop that one when the user asked.
  \`bunx buncargo stop <app>\` stops one app and \`bunx buncargo restart <app>\`
  restarts one.
- Stopping can take as long as an app's \`stopGraceMs\`: up to a minute for
  an app that saves data as it exits, such as the Firebase emulators. Let it
  finish; killing it loses that data.
- An app already running in another terminal is reused, not started twice.
  One that fails its health check is replaced when its run was started with
  \`--detach\` or is gone; one in someone's terminal needs \`--takeover\`.
- An interactive app (Expo) runs in a terminal of its own when you have none.
  Press its keys with \`bunx buncargo send <app> <keys>\`, e.g.
  \`bunx buncargo send expoApp r\` to reload it. Exit 3 means the app could not
  take them (it says why), 2 that no run started it. Do not wrap it in
  \`script\` or \`tail -f /dev/null\`.
- \`bunx buncargo expo sim\` opens this checkout's Expo app in its own iOS
  simulator. Expo's own \`i\` key opens whichever simulator booted first, which
  may be another worktree's.
- Apps with a \`watch\` config restart themselves when their files change; do
  not run them under \`bun --watch\` as well.

## Readiness

- \`bunx buncargo wait --app=<app>\` blocks until the app is healthy (exit 0),
  failed (1) or timed out (2). Use it instead of \`sleep\` or \`curl\` loops.

## Reading the environment

- \`bunx buncargo url <app>\` prints the URL to open. When \`BUNCARGO_URL_HOST\`
  is set, the person is on another machine: hand them that URL, not localhost.
  With \`BUNCARGO_HOSTS=tailscale\` it is \`https://<machine>.ts.net:<port>\`,
  served by Tailscale; a warning at startup says when an app fell back to its
  plain URL, and \`bunx buncargo doctor\` says why.
- \`bunx buncargo env --get DATABASE_URL\` prints any variable the apps get, and
  \`bunx buncargo env --get ports.<name>\` one port.
  \`eval "$(bunx buncargo env --export)"\` loads them all into a shell.
- \`bunx buncargo status --json\` is ports, containers, URLs and app states as one
  object. A run whose service container stopped under it has \`health:
  "degraded"\` and the service's \`problem\`; \`plannedOffset\` set means the
  next \`dev\` moves the ports, so start the run before testing against them.
- \`bunx buncargo env set KEY=VALUE\` overrides a variable for every run, exec
  and task of this checkout (\`env unset KEY\` drops it). Use it when a shared
  \`.env.local\` points at another checkout's port, instead of prefixing every
  command with the variable.
- \`bunx buncargo exec -- <command>\` runs a command with this checkout's
  environment. \`bunx buncargo run <task>\` runs a configured task;
  \`bunx buncargo help\` lists them.

## Gitignored files (.env.local)

- When the config lists \`checkoutFiles\`, buncargo copies those files into this
  checkout from the machine's file store before any command reads them. Do not
  copy them from another worktree by hand.
- \`bunx buncargo files status\` shows each one's state. A file with local
  edits is never overwritten: \`bunx buncargo files save <path>\` shares the
  edit with every checkout, and \`bunx buncargo files pull --force <path>\` takes
  the store's copy. For a \`conflict\` (both changed), run
  \`bunx buncargo files merge <path>\` first when the hint offers it (dotenv
  files): it keeps both sides' changes key by key. Merge exits 1 naming keys
  changed on both sides; rerun it with \`--checkout=KEY,...\` or
  \`--store=KEY,...\`. None of them prints values; \`files diff\` lists
  differing keys.
  Ask the user before saving or forcing a file you did not change on purpose.

## Checks

- \`bunx buncargo typecheck --changed\` checks the workspaces this branch
  touched and the ones depending on them.
- Typechecks share a few slots across every checkout on the machine. One that
  says it is waiting for a slot is not stuck; let it wait.
- Run test suites as \`bunx buncargo slot -- <command>\` so they take a slot
  too. \`slot\` leaves the environment alone; \`exec --slot\` adds the
  checkout's URLs and secrets.

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

## Sharing beyond this machine

- \`bunx buncargo dev --detach --expose\` (or \`--expose=api\`) also opens a
  public Cloudflare quick tunnel to each \`expose: true\` app or service, for a
  webhook or a phone on another network. Anyone with the URL reaches the app:
  only expose when the user asked. To reach an app yourself, use
  \`bunx buncargo url <app>\`. The public URLs are in
  \`bunx buncargo status --json\` (\`tunnels\`); the tunnels close when the run
  stops. A target without \`expose: true\` makes \`dev\` exit 1 before starting.
- When \`BUNCARGO_CONNECT_TOKENS\` is set (a cloud sandbox), \`dev\` shares
  every selected app and service with the token holders on its own; there is no
  flag, and sharing ends with the run. A sharing failure never stops the run:
  \`bunx buncargo connect status --json\` shows it.
- \`bunx buncargo connect tcp <target-id>\` opens a private local port to a
  shared database another machine runs and prints it as JSON (exit 1 when it
  cannot); \`bunx buncargo connect disconnect <target-id>\` closes it when you
  are done. Target ids come from \`connect status --json\`. \`connect token\`
  prints this machine's recipient token, a secret: never write it into a file.
  \`connect token --rotate\` and \`connect revoke\` cut recipients off; run them
  only when asked.

## Do not

- \`dev --reset\` deletes this checkout's database (not Firebase emulator
  data, which lives in \`.firebase-emulator-data\`) and \`dev --down --all\` stops
  every checkout's run. Both refuse without a terminal unless \`--yes\` is
  passed. Pass it only when the user asked for exactly that.
- Do not edit \`.buncargo/\`, the generated compose file or other generated
  files such as \`firebase.buncargo.json\`.

## When something fails

- \`bunx buncargo doctor\` checks Docker, ports, named hosts and leftovers.
  \`doctor --fix\` starts Docker, force-restarts a Docker Desktop that has run
  for minutes without answering (it stops every checkout's containers; say so
  to the user first), and stops a process of a deleted checkout holding a port.
- A run line "postgres stopped (exit 0)" means a service container went down
  under the run; buncargo does not restart it. The line says which buncargo
  command stopped it, or that none did. Restart the run
  (\`bunx buncargo stop --all\`, then \`bunx buncargo dev --detach\`) and
  tell the user what stopped it.
- \`bunx buncargo setup --yes\` runs the fix of every failing check (missing
  dependencies, generated files).
- A port "held by an unidentified process" is usually a system service. Run
  \`dev\` again: buncargo moves the checkout to a free port block.
- A warning that names who removed this checkout's containers (a watchdog,
  \`stop\`, \`dev --down\`) explains a refused database connection: the
  stack is gone, not broken. Start the run again; report the remover to the
  user if it was another worktree's or another user's.
- \`dev\` refusing because another checkout "already uses" its Compose project:
  the two would share one database. Do not work around it; tell the user, who
  gives one of them its own \`projectPrefix\`, or, when the other checkout's
  claim is from a config it no longer runs, releases it with the
  \`bunx buncargo ports release --root <path>\` the error names. Run that only
  when the user asks: whoever runs under the name next gets its volumes.
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
