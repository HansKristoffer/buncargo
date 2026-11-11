import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors";

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
 *
 * The core is short on purpose. Agents read it through `| head -60` or a grep,
 * and a 12 KB guide cut that way never showed its "Databases" and "When
 * something fails" sections, so the agents that hit a full port range started
 * Postgres with `docker run`. The rules that must not be missed and the
 * failure recipes come first; the rest is `help agents <topic>`.
 */
const CORE = `# buncargo for agents

This checkout runs its services (databases, caches) and apps (dev servers)
through buncargo, with ports, containers, URLs and a database of its own.
Ask buncargo for them; never reuse another checkout's or hardcode a port.

Never:
- \`docker run\` a database or \`docker exec\` into one by name: other worktrees
  run their own. Use \`bunx buncargo sql\` (\`help agents db\`).
- \`nohup\`, \`&\`, \`disown\` or \`sleep\` loops: \`dev --detach\` and \`wait\` do it.
- \`dev --reset\` (deletes this checkout's database) or \`dev --down --all\`
  (stops every checkout), unless the user asked for exactly that.
- Edit \`.buncargo/\`, \`~/.buncargo/\` or generated files, set
  \`BUNCARGO_PORT_OFFSET\`, or kill processes and containers by name.

Use:
- \`bunx buncargo dev --detach\`: starts the run, returns once apps are up.
- \`bunx buncargo wait --app=<app>\`, \`bunx buncargo status --json\`.
- \`bunx buncargo url <app|service>\`, \`bunx buncargo env --get DATABASE_URL\`.
- \`bunx buncargo exec -- <command>\` runs a command with this checkout's env.
- \`bunx buncargo sql -c "<sql>"\`, \`bunx buncargo logs <app> --errors\`.
- \`bunx buncargo stop\` stops this checkout's run. Before you finish a task,
  run it unless the person is still using the app. A run in their own
  terminal is left running (exit 3): leave it.

When something fails:
- The cause and the next command end the output. Add \`; echo $?\`, not \`| tail\`.
- "Could not allocate a free port block": \`dev\` takes back an idle block on
  its own, so this lists holders still in use. Tell the user (\`help agents ports\`).
  \`"unallocated"\` in \`status --json\` means the ports shown are not yours.
- "a stale stack of this checkout": \`bunx buncargo dev --detach --replace-stale\`.
- Infisical session expired (\`bunx buncargo secrets check\` exits 2): ask the
  user to run the \`infisical login --domain=…\` it prints. Never call
  \`infisical\` yourself; no buncargo command prints a secret's value.
- Anything else: \`bunx buncargo doctor\`, then \`help agents fail\`.

More: \`bunx buncargo help agents <topic>\` (or \`all\`), topics:
TOPICS.
Source: https://github.com/HansKristoffer/buncargo; the package ships it in
node_modules/buncargo/src, and dist/*.js.map map the bundles back to it.`;

interface Topic {
	name: string;
	/** Other names agents ask for it by (\`help agents sql\`). */
	aliases?: readonly string[];
	body: string;
}

const TOPICS: readonly Topic[] = [
	{
		name: "start",
		body: `## Start and stop

- \`bunx buncargo dev --detach\` starts the run in the background and returns once
  every app is up. Exit 1 names the apps that did not come up; the others keep
  running. Exit 0 also when every app was already running and is reused. Exit
  2: still starting after 10 minutes; the run goes on, so wait with
  \`bunx buncargo wait --app=<app>\`. Do not use \`nohup\`, \`&\` or \`disown\`.
- When it fails, the last block of its output names what failed (an app, the
  seed or a step), shows its last 20 lines and the setup checks that warned,
  and says what to run next: \`dev --detach; echo $?\` shows it with the
  exit code. Do not run \`dev\` again to find the cause.
- \`bunx buncargo dev --detach --apps=api\` starts only some apps (and the apps
  they require). \`--profile=<name>\` picks a configured set.
  \`bunx buncargo dev --up-only\` starts the services alone and returns once
  they are up (no \`--detach\`).
- \`bunx buncargo stop\` (the same as \`stop --all\`; \`down\` runs it too) stops
  this checkout's run, and removes the containers an ended run left waiting
  out its idle hold. A run someone started
  in a terminal (not with \`--detach\`) asks first, and without a terminal needs
  \`--force\`: only stop that one when the user asked.
  Exit 3 means something was left running; nothing running exits 0, and a
  mistyped flag 1.
  A container runtime that refuses this user or does not answer may still
  run the containers, so \`stop\` exits 3 and \`dev --down\` exits 1 rather
  than reporting nothing to stop: once \`docker version\` answers, stop again.
  \`bunx buncargo stop <app>\` stops one app and \`bunx buncargo restart <app>\`
  restarts one; \`restart <app> && wait --app=<app>\` waits for the new process.
  \`restart\` exits 3 when the run is a script's \`start()\`, which takes no
  restart requests: nothing was restarted.
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
  failed (1), timed out (2) or was interrupted before it was healthy (130,
  143). With \`--hold\`, a signal after that exits 0. Use it instead of
  \`sleep\` or \`curl\` loops.`,
	},
	{
		name: "runs",
		body: `## Who owns a run and its containers

- A run is one \`buncargo dev\`, or one \`start()\` from a script.
  \`~/.buncargo/runs.json\` records it with its pid. \`bunx buncargo ls\` lists
  the runs of every checkout, \`bunx buncargo status --json\` this one's.
- \`dev\` in a terminal: when it ends, its containers wait out an idle hold
  (three minutes, or \`options.autoShutdown\`) for the next run, then the
  watchdog removes them.
- \`dev --detach\`: the run is a background process of its own (its own systemd
  scope on Linux), not a child of your shell, so your session or harness
  ending does not stop it. \`bunx buncargo stop\` does, and so does the
  watchdog: after 2 hours with no request through its named URLs, no open
  connection to its apps' ports and no \`buncargo\` command in the checkout
  (any command, \`status\` included, resets the clock), and once its
  checkout has been deleted. \`dev --detach --keep\` turns the idle limit
  off, for a long job that nothing connects to. With
  \`BUNCARGO_HOSTS=tailscale\` there is no idle limit; \`dev --detach\` says
  which applies. \`bunx buncargo runs\` shows
  the time left (\`idleStopsAt\` in \`runs --json\`); when a run is gone,
  \`stop\` and \`ls\` say whether the watchdog stopped it and why. Start it
  again with \`dev --detach\`.
- A script that calls \`start()\` (a setup script, a test helper) and exits
  keeps its containers for as long as the checkout exists, unless it asked for
  a hold with \`claimRun({ idleTimeoutMs })\`. Its exit does not stop them.
  When it reused containers an ended CLI run was holding, it takes over that
  run's hold, and they go when the hold runs out after it ends.
- A run whose process dies without stopping (a crash, \`kill -9\`) loses its
  containers about 15 seconds after the watchdog notices.
- The watchdog is one background process per machine. Every 30 seconds it
  removes containers that nothing holds any more: a deleted checkout's, a run's
  whose hold ran out, a crashed run's. It never touches a live run's
  containers and never removes a volume, so a database survives every stop;
  only \`dev --reset\` and \`buncargo prune\` delete data.
- A warning that names who removed this checkout's containers (a watchdog,
  \`stop\`, \`dev --down\`) explains a refused database connection: the
  stack is gone, not broken. Start the run again; report the remover to the
  user if it was another worktree's or another user's.`,
	},
	{
		name: "env",
		body: `## Reading the environment

- \`bunx buncargo url <app>\` prints the URL to open, and \`url <service>\` a
  service's (its connection URL, \`postgres://…\`, when it has no HTTP one).
  When \`BUNCARGO_URL_HOST\` is set, the person is on another machine: hand
  them that URL, not localhost. With \`BUNCARGO_HOSTS=tailscale\` it is
  \`https://<machine>.ts.net:<port>\`, served by Tailscale; a warning at
  startup says when an app fell back to its plain URL, and
  \`bunx buncargo doctor\` says why. A plain \`http://\` URL on another host is
  no secure context (\`crypto.randomUUID\`, the clipboard and service workers
  fail there): a browser you drive on this machine gets
  \`bunx buncargo url <app> --local\`.
- \`bunx buncargo env --get DATABASE_URL\` prints any variable the apps get, and
  \`bunx buncargo env --get ports.<name>\` one port.
  \`eval "$(bunx buncargo env --export)"\` loads them all into a shell.
- \`bunx buncargo status\` starts with one line per app (\`name  status  url\`).
  \`status --json\` is app states (\`runs\`, first), ports, containers and URLs
  as one object. A run whose service container stopped under it has
  \`health: "degraded"\` and the service's \`problem\`; \`plannedOffset\` set
  means the next \`dev\` moves the ports, so start the run before testing
  against them.
- \`bunx buncargo env set KEY=VALUE\` overrides a variable for every run, exec,
  task, \`env\` and \`sql\` of this checkout (\`env unset KEY\` drops it). Use it
  for a mode the stack should keep (\`env set HUBSPOT_MODE=simulator\`) or when
  a shared \`.env.local\` points at another checkout's port, instead of
  prefixing every command with the variable.
- \`bunx buncargo exec -- <command>\` runs a command with this checkout's
  environment. \`bunx buncargo run <task>\` runs a configured task;
  \`bunx buncargo help\` lists them.`,
	},
	{
		name: "db",
		aliases: ["sql", "prisma"],
		body: `## Databases

- \`bunx buncargo sql\` opens the database's own client in this checkout's
  container. \`bunx buncargo sql -c "select …" --json\` runs one query and prints
  the rows as JSON. \`bunx buncargo sql redis -c "GET key"\` works for Redis.
- SQL in a heredoc or a pipe runs as a script and stops at the first error.
  Pass psql flags after \`--\` (\`-- -tA\`, \`-- -v name=value\`);
  \`-- -f file.sql\` reads a file on this machine. \`--json\` prints the rows of
  one SELECT or WITH; anything else runs as plain SQL, with a note on stderr.
- For a throwaway database (a migration check, a test run),
  \`bunx buncargo sql --create-scratch=<name>\` creates an empty
  \`scratch_<name>\` in this checkout's Postgres (recreated each time) and
  prints only its URL. It starts the Postgres service alone when it is down.
  \`bunx buncargo sql --drop-scratch=<name>\` removes it. Do not \`docker run\`
  a Postgres of your own.
- To use one that exists as it is: \`bunx buncargo sql --db=scratch_<name> -c
  "…"\`, and \`--db=scratch_<name> --url\` prints its URL.
- \`bunx buncargo exec --db=scratch_<name> -- <command>\` points every variable
  whose URL names this checkout's database (\`DATABASE_URL\`, direct and pooled
  ones) at that database. Do not rewrite \`DATABASE_URL\` by hand. It exits 1
  when the database does not exist or nothing points at it.
- \`bunx buncargo prisma <args>\` runs Prisma against this checkout's database,
  starting it if needed; its stdout is Prisma's alone, so
  \`bunx buncargo prisma migrate diff --script > migration.sql\` is only SQL.
  \`migrate reset\` and \`db push --force-reset\`/\`--accept-data-loss\` drop data
  and exit 1 without \`--yes\`: do not pass it to fix a migration, ask first.
- New migration: \`bunx buncargo prisma migration new <name>\`. It needs no
  terminal, prints only the new folder's path on stdout, and exits 1 when the
  schema has nothing new. Do not use \`migrate dev --create-only\` or pick a
  timestamp by hand. Before you push, \`bunx buncargo prisma migration check\`
  exits 1 when a migration's timestamp collides or sorts before the newest one
  on the base branch; recreate it with \`migration new\`.
- \`bunx buncargo prisma --db=scratch_<name> <args>\` runs Prisma against a
  scratch database (create it with \`sql --create-scratch\`); destructive
  commands need no \`--yes\` there.
- A "points at <host>, not this checkout's database" warning names an
  inherited variable Prisma may read instead: unset it before any write. With
  one set, destructive commands exit 1 even with \`--yes\`.
- Exit 4 from \`buncargo prisma\`: the database applied migrations this
  checkout no longer has (a squashed chain). Only \`bunx buncargo dev --reset
  --yes\` fixes it, and it drops the data: stop and ask the user.
- Do not \`docker exec\` into a database by name or read credentials from the
  generated compose file: other worktrees run databases of their own.`,
	},
	{
		name: "ports",
		body: `## Ports

- Each checkout keeps its port block (\`bunx buncargo ports\` shows its offset
  and every claim on the machine). \`ci\` and E2E stacks, and every environment
  in CI, give theirs back when torn down. Do not set \`BUNCARGO_PORT_OFFSET\` or
  edit \`.buncargo/ports.json\`; to move a checkout,
  \`bunx buncargo ports pin <offset>\`.
- A checkout with no block of its own while every block is claimed reads as
  \`portOffsetProvenance: "unallocated"\` (\`status --json\`, \`env\`,
  \`ports\`): the ports shown belong to another checkout. Do not test against
  them, start a database of your own or write \`.buncargo/ports.json\`. Run
  \`bunx buncargo dev --detach\`: when the range is full it takes back the
  block of the checkout used least recently that has no run and no
  containers, and says whose. That checkout keeps its containers, volumes and
  project name and gets new ports on its next start.
- If \`dev\` still fails with "Could not allocate a free port block", the
  error lists every holder with its state and age and the offset to pin. Only
  when the user asks, free blocks with
  \`bunx buncargo ports release --idle=7d --yes\` (checkouts unused for a
  week, with no run and no containers) or \`bunx buncargo ports pin <offset>\`.
- A port held by "a stale stack of this checkout" is this checkout's stack from
  before its \`projectPrefix\` changed, still up under the old name. Run
  \`bunx buncargo dev --detach --replace-stale\`; it needs no asking. It removes
  only this checkout's stale stacks that hold the run's ports, keeps their
  volumes, and leaves any stack another checkout or a live run uses.
- A port "held by an unidentified process" is usually a system service. Run
  \`dev\` again: buncargo moves the checkout to a free port block.
- \`dev\` refusing because another checkout "already uses" its Compose project:
  the two would share one database. Do not work around it; tell the user, who
  gives one of them its own \`projectPrefix\`, or, when the other checkout's
  claim is from a config it no longer runs, releases it with the
  \`bunx buncargo ports release --root <path>\` the error names. Run that only
  when the user asks: whoever runs under the name next gets its volumes. It
  exits 3 when a run started there meanwhile kept a claim; tell the user.`,
	},
	{
		name: "logs",
		body: `## Logs

- \`bunx buncargo logs <app> --errors\`, \`--since=5m\`, \`-f\`. App output is kept
  per run, so it is there after the terminal scrolled or the run ended. It
  reads the live run that runs <app>; \`--run=<sessionId>\` picks another
  (\`bunx buncargo runs --json\` lists them). \`-f\` exits 0 when the run ends.
- \`--errors\` keeps the lines that read as errors (a logger's own INFO or WARN
  level wins over a word like "failed"), with the \`{ … }\` block that follows
  one. It can hide a line such as \`MISSING_SECRETS: X\`: when an app will not
  start, read \`bunx buncargo logs <app>\` whole.`,
	},
	{
		name: "check",
		body: `## Checks

- \`bunx buncargo check\` is the check for your change: \`bun fmt\` (when the
  config sets \`check.format\`) and Biome on the changed files, writing their
  fixes, \`typecheck --changed\`, the project's gates and the tests next to
  the changed files. It ends with \`PASS\`, or \`FAIL:\` and one line per failed
  step with its exit code and the command that reruns it, and exits 1 on a
  failure. \`--staged\` is the pre-commit hook and writes nothing; \`--all\`
  checks everything.
- \`bunx buncargo typecheck --changed\` checks the workspaces this branch
  touched and the ones depending on them.
- Typechecks share a few slots across every checkout on the machine. One that
  says it is waiting for a slot is not stuck; let it wait.
- Run test suites as \`bunx buncargo slot -- <command>\` so they take a slot
  too. \`slot\` leaves the environment alone; \`exec --slot\` adds the
  checkout's URLs and secrets; \`ci --slot -- <command>\` runs it against a
  throwaway stack of its own.`,
	},
	{
		name: "files",
		body: `## Gitignored files (.env.local)

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
  Ask the user before saving or forcing a file you did not change on purpose.`,
	},
	{
		name: "share",
		body: `## Sharing beyond this machine

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
  only when asked.`,
	},
	{
		name: "fail",
		body: `## When something fails

- \`bunx buncargo doctor\` checks Docker, ports, named hosts and leftovers.
  \`doctor --fix\` starts Docker, force-restarts a Docker Desktop that has run
  for minutes without answering (it stops every checkout's containers; say so
  to the user first), and stops a process of a deleted checkout holding a port.
- A run line "postgres stopped (exit 0)" means a service container went down
  under the run ("keeps restarting" and "is paused" likewise); buncargo does
  not restart it. The line says which buncargo command stopped it, or that
  none did. Restart the run
  (\`bunx buncargo stop\`, then \`bunx buncargo dev --detach\`) and
  tell the user what stopped it.
- No \`bun install\` first: in a fresh worktree, or after \`bun.lock\` changed,
  buncargo runs \`bun install --frozen-lockfile\` itself (postinstall scripts
  included) and then your command, with the install's output on stderr so
  \`--json\` stays clean. If that install fails, fix what it printed and run
  \`bun install\`.
- \`bunx buncargo secrets check --json\` before tests or a run that needs
  secrets: exit 0 when every Infisical scope is readable, 2 when the session is
  missing or expired (the user runs the \`infisical login --domain=…\` it
  prints), 3 when a scope cannot be read: Infisical unreachable, or a 403
  (set \`secrets.organizationId\`); \`error\` says which. \`dev\`, \`run\`
  and \`exec\` stop within seconds on an expired session instead of hanging,
  and only warn when Infisical is unreachable.
- A browser page of another checkout failing with \`ERR_NETWORK_CHANGED\`
  while a run starts or stops: Docker creating or removing a stack's network
  makes Chrome drop its requests. It is a known buncargo issue, not the app;
  reload the page, and do not share one network between projects to avoid it.
- \`bunx buncargo setup --yes\` runs the fix of every failing check (missing
  dependencies, generated files).
- Docker out of disk, or hanging: \`bunx buncargo prune --project --dry-run\`
  lists this project's leftover \`ci\` stacks and deleted worktrees' stacks.
  Removing them deletes their data, so ask before running it without
  \`--dry-run\`. It never touches an existing checkout's dev database.`,
	},
	{
		name: "config",
		body: `## Changing dev.config.ts

- Housekeeping that needs the database before any app starts (unlocking stale
  jobs, resetting a queue) goes in \`hooks.afterContainersReady\`: it runs on
  every start, after migrations and before the apps. \`preflight\` runs before
  the containers start, so the database is not up yet there.
- Tools that change behaviour in an agent's shell can be kept from seeing it with
  \`unsetEnv: ["VAR", …]\`, which removes those variables from every process
  buncargo starts, except the Prisma CLI: Prisma reads them to guard its
  destructive actions.`,
	},
];

/** The core, naming its topics. */
export const AGENTS_GUIDE = CORE.replace(
	"TOPICS",
	TOPICS.map((topic) => topic.name).join(", "),
);

export const AGENTS_GUIDE_TOPICS: readonly string[] = TOPICS.map(
	(topic) => topic.name,
);

/** `help agents [topic]`: the core, one topic, or `all` of it. */
export function agentsGuide(topic?: string): string {
	if (topic === undefined) return AGENTS_GUIDE;
	if (topic === "all")
		return [AGENTS_GUIDE, ...TOPICS.map((entry) => entry.body)].join("\n\n");
	const found = TOPICS.find(
		(entry) => entry.name === topic || entry.aliases?.includes(topic),
	);
	if (!found)
		throw new CliError(`No agents guide topic named "${topic}".`, [
			`Topics: ${[...AGENTS_GUIDE_TOPICS, "all"].join(", ")}.`,
		]);
	return found.body;
}

const BLOCK_START = "<!-- buncargo:start -->";
const BLOCK_END = "<!-- buncargo:end -->";

/** The block `setup --agents` keeps in AGENTS.md: the rules agents missed, and the guide. */
export const AGENTS_BLOCK = `${BLOCK_START}
## Dev environment (buncargo)

Services and dev servers run through buncargo, with ports, containers, URLs
and a database of their own per worktree. \`bunx buncargo help agents\` is the
guide (40 lines; \`help agents <topic>\` for more). The rules:

- Never \`docker run\` a database of your own: use \`bunx buncargo sql\`, and for a
  throwaway one \`bunx buncargo sql --create-scratch=<name>\`.
- Start: \`bunx buncargo dev --detach\`. Stop: \`bunx buncargo stop\`, before
  you finish a task too, unless the person is still using the app.
- "Could not allocate a free port block": \`dev\` takes back an idle block on
  its own, so the holders the error lists are in use. Tell the user; do not
  work around it.
- Values: \`bunx buncargo env --get DATABASE_URL\`, \`bunx buncargo url <app>\`,
  \`bunx buncargo status --json\`. Wait: \`bunx buncargo wait --app=<app>\`.
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
