# CLI

`src/cli/bin.ts` is the executable; `runCli` is published through `buncargo/api`. `run-cli.ts` is the
dev flow; `dev-flags.ts` (the dev command's spec and the rules between its flags), `dev-hosts.ts`
and `dev-tunnels.ts` hold the pieces it orchestrates.

## Commands, flags and errors

- `version-guard.ts` runs first in `bin.ts`: inside a project whose `node_modules/buncargo` (the
  first found from the working directory up to the repository root) is another version, it
  `execve`s that package's `bin` with the same arguments, so the pid, stdio and signals stay the
  run's. `BUNCARGO_REEXEC` stops a second hand-over and is removed before anything starts, so
  apps never inherit it. A `package.json` listing buncargo with nothing installed is a
  `CliError`. A CLI run from `src/` is never replaced: that is someone testing the source. It
  reads files only; a matching version costs a few `stat`s.
- Before that decision, a checkout installs itself (`checkout-install.ts`): when a `package.json`
  from the working directory up lists buncargo and the first `bun.lock` above it has no
  `node_modules` beside it, or one installed from another lockfile, the guard runs
  `bun install --frozen-lockfile` there and decides again, so the fresh install can still hand
  over. A missing `node_modules` installs for every command (none of the project's buncargo runs
  without it); a stale one only for the commands that run the project's code
  (`refreshesStaleInstall`). `stop`, `status` and BuncargoBar's buttons must neither reinstall
  under a running run nor fail on a broken lockfile. "Installed from" is `install-stamp.ts`'s hash of `bun.lock`: Bun
  1.4 writes nothing into `node_modules` on a no-op install, so no file of its own can say, and
  `git checkout` rewrites the lockfile's time without its content. A checkout with no stamp
  falls back to `node_modules` being newer than `bun.lock`, so one installed by hand is left
  alone. The install's stdout goes to stderr (a `--json` command's stdout stays one document),
  waits on a per-checkout lock (several agents in one fresh worktree install once), and runs
  with `BUNCARGO_INSTALLING=1`, so a buncargo in a postinstall script does not start another.
  The guard never installs from source or after a hand-over. An install that replaces the
  package this process runs from re-executes it, since the rest of its modules load lazily.

- Every command module exports one `defineCommand({ spec, exits, json?, run })` (`command-spec.ts`),
  or a `defineGroup` of them for subcommands (`files`, `ports`, `hosts`, …). The spec is the only
  description of what the command accepts: `parseArgs(spec, argv)` reads it (over `node:util`
  `parseArgs` tokens), and the same spec renders `--help`, the root help row and, with `exits`,
  the `help agents exits` table. Add a flag to the spec and read it from `parsed.values`, typed
  by the spec; never look at argv again. Rules between flags (`--keep` needs `--detach`) live
  beside the spec and throw `argumentsError`.
- `parseArgs` is strict on purpose: an ignored flag was a silent wrong answer (`status --jsno`
  printed prose and exited 0, `dev --profile` ran the default profile). A separated value that
  starts with `-` is refused rather than read, so `--profile --apps=x` cannot name a profile
  `--apps=x`. An optional value (`--expose[=x]`) is only ever inline, or `dev --expose api` would
  be ambiguous now that `dev` takes app names. `forwardUnknown` is for `prisma` alone, whose
  arguments are Prisma's.
- `exits` lists every code a command returns. `1` is failure or bad arguments everywhere; the
  others mean one thing per command, and `stop`, `send` and `restart` share theirs (2 no such
  target, 3 refused) because BuncargoBar and agents branch on them.
- `commands/registry.ts` lists the top-level commands as lazy loaders: `bin.ts` loads only the one
  it runs, and only the root help and `help agents exits` load them all (about 70 ms). buncargo
  reads only the first argument as the command, so `--help dev` is help and `--json runs` is an
  unknown command. `cli-output.test.ts` pins every command's `--help` and the root. A changed or
  removed line in its snapshot is a breaking change; an added command or flag only adds lines.
- Each JSON document a command prints has a type in `json-documents.ts`, which the command builds
  with `satisfies`, and a test that pins its keys: scripts and agents parse them.
- Failures inside a command flow throw `CliError` (`errors.ts`) so the flow can release tunnels,
  host routes and the terminal before exiting 1. Argv problems are an `ArgumentsError`, which
  `runCommand` prints and turns into exit 1.
- `log.ts` is the CLI status and error facade (`info`/`success`/`done`/`warn`/`error`/`hint`/`fail`);
  `src/environment/logging.ts` stays responsible for the rich environment banner.
- `commands/` contains command-specific behavior; `commands/inspect/` holds `ls`, `status` and
  `doctor`. `stop-all.ts` sits alongside them but is not a command: it backs `dev --down --all`.

## The dev flow

- `takeover.ts` answers the dead end where every selected app was already running: the run used
  to print "nothing to start" and exit, leaving the developer to find the other window. It
  prompts, and on `y` (or `--takeover`) stops those ports' owners and spawns them here. Reuse stays
  the default and a bare Enter declines, because taking over kills servers in a terminal the
  developer may not be looking at. Only apps with a `devCommand` are candidates: stopping the port
  of one buncargo does not spawn would leave it down instead of moving it. The other run tears
  itself down safely: `releaseNamedHosts` drops only routes carrying its own pid, and
  `env.releaseRun()` releases the containers to the watchdog's idle hold rather than stopping them.
  The decision is made *before* `logSelectedAppsSummary` and the banner, so both describe the run
  that actually happens and the reclaimed hostnames are the ones printed. `run-cli.ts` then calls
  `activateNamedHosts` a second time with the taken-over app names. The first attempt left the
  other run as the routes' owner (`keep`), and that `buncargo dev` is still alive after its server
  is killed, so its exit would delete the routes and the new run's named URLs would 404. The
  `takeover` option moves those routes, and only those, to this run's pid.
- An app whose port is busy but fails its health check is never reused. `port-reuse.ts` stops a
  leftover of this checkout that no live run lists (a dev server that outlived a run killed hard),
  since the spawner would kill it anyway. A live sibling run's server is handed to the takeover
  instead, never killed during classification: only the takeover retries the named hosts that run
  still owns. A `--detach` run's server is taken over without asking, as `stop` does; one in a
  terminal is asked about, and without a terminal the run refuses and names `--takeover`. A
  Lullu `dev --detach` whose Astro server answered 500 used to block every later `dev` with no
  way through but finding and stopping it.
- `checks.ts` runs `SetupCheck`s (core from `core-checks.ts`, then the config's, then
  integrations'). `dev` runs only `fast !== false` ones before anything starts, not in the one-shot
  modes; warnings are printed and never stop it. `commands/setup.ts` offers each fix (`--yes` or CI
  runs them all; a terminal-less run without `--yes` only reports), then checks again. `doctor`
  lists them. A check that throws counts as failed.
- `preflight.ts` runs `config.preflight` (and integrations') after the fast checks, with the real
  terminal, filtered by each step's `apps`. A throw is a `CliError` with the step's name.
- `dev-detach.ts` is `dev --detach`: the same argv without the flag, re-run with `detached: true`
  (its own session, so a harness's SIGTERM does not reach it) and, on Linux with a user manager,
  in a systemd scope of its own (`process/user-scope.ts`), so restarting the service the harness
  runs as does not kill it with that service's cgroup. Its output goes to
  `.buncargo/logs/detached-<pid>.log`, one per run, with `detached.log` a link to the newest: a
  second `dev --detach` in the checkout starts while the first still writes its log, and a shared
  log rotated aside was renamed over by the third. A run's log and report are pruned once it is
  dead and they are a minute old, keeping the newest ended run's log.
  The parent waits on the run registry entry whose `pid` is the
  child's until every app has settled; an empty `apps` list is the claim, not "done", unless the
  selection has no app to spawn. Whether it has one is the child's to say, in its report
  (`expectApps`): the parent never loads the config, which cost a second environment build on
  every `dev --detach`. A config error reaches the parent as the child's exit. A child that exits 0 had nothing to keep running (every app
  reused) and is a success, as it is for attached `dev`; its exit is checked before the entry,
  which can outlive it. The run hands the parent its failures in
  `.buncargo/logs/detached-report-<pid>.json`, one per run for the same reason
  (`run-failure.ts`: the cause, the step's last lines, the
  setup warnings, what to run next), and the parent prints them last. Parsing the log for the
  cause failed: agents read `dev | tail`, and the tail was a warning of kilobytes. An app that
  crashed while it started reads `failed` from its exit before it is parked and reported, so the
  parent gives a settled run's down apps `REPORT_GRACE_MS` for their reports before printing.
  Still starting at the timeout exits 2, as `wait` does, apart from a failure's 1.
  `--keep` is not passed on: the child learns it from `BUNCARGO_DETACHED`
  (`1` or `keep`), and records the idle limit the watchdog enforces
  ([run registry](./run-registry-and-sweep.md#detached-runs-that-end)).
- A bare `stop` is `stop --all`: agents and project docs wrote `buncargo stop` meaning "stop my
  run" and got an error 26 times. The terminal-run confirmation still applies, so it stops a
  detached run without asking and refuses (exit 3) one in another terminal when there is no
  terminal to ask in. `down` is an alias (`resolveCommandAlias` in `commands/registry.ts`, kept out
  of help) that prints a hint naming `stop`.
- `dev-flags.ts`' `destructiveModeGate`: `--reset` and `--down --all` ask in a terminal and refuse
  without one unless `--yes`. CI is exempt. An agent ran `--reset` to fix a migration and deleted a
  developer's data.
- `bar-offer.ts` is the one-question offer of the menu bar app inside `dev`, and `commands/bar.ts`
  the `install`/`status`/`open`/`uninstall`/`reset` group over `core/menubar.ts`. The offer's gates
  are checked cheapest-first and bail on two `existsSync` calls in the common case, because `dev`
  runs constantly.

## Other commands

- `commands/run.ts` is `exec` for `config.tasks` (which injects the app's secrets), with
  `requiredServices` started through `env.withServices`. It claims with the CLI's idle
  hold, not the library's keep-forever default. Extra argv goes through `withAppendedArgs`
  (`sh -c '<cmd> "$@"'`), so nothing is re-parsed. Tasks are published into the run entry for
  BuncargoBar's run button, which calls `buncargo run` *unscoped*: `--root`/`--run` name a run, and
  a task only needs the checkout (the working directory).
- `commands/ci.ts` runs on `env.withSuffix("ci-<id>", { data: "tmpfs", ports: "assigned" })`, starts services with
  `withServices` (`after: { stop: { removeVolumes: true } }`), forces the seed (a CI database is
  never warm) and runs the command; `--schema=push` is the preparation's `schema: "push"`. The suffix is not optional: on the shared project that teardown
  deletes a developer's dev database. The id is per run because two runs on one `-ci` project took
  each other's stack down mid-test (lasauna), and tmpfs because a killed run's volume was nobody's to
  remove. A suffixed environment writes its own compose file, or it would overwrite the dev
  run's; `ci` deletes its file after the teardown. Its services publish on Docker-assigned ports
  (`127.0.0.1::5432`, read back from the listing; see `container-runtimes.md`). `--profile` lives in `dev-flags.ts`; `selectProfileApps` in
  `run-cli.ts` turns it (or a `default` profile) into the same selection `--apps` makes.
- `agents-guide.ts` is the one copy of the agent guide (`help agents`) and the `AGENTS.md` block
  `setup --agents` keeps between `<!-- buncargo:start/end -->` markers. It lives in code, not
  `docs/`, so the guide an agent reads matches the installed version. The core stays under 40
  lines with the never-rules and failure recipes first, and the rest is `help agents <topic>`:
  agents read it through `| head -60` or a grep, and the 12 KB single page they cut that way
  never showed them the database and port-block recipes.
- `commands/ports.ts` shows the offset claims and `pin`s one: it checks every port of the block
  through `withBindProbe` and the claims before writing the claim. `release`
  drops another checkout's claims under the claims lock, refusing while that checkout has a live or
  held run.
- `commands/send.ts` types into an app over the same request-file channel as `restart`
  (`restart-requests.ts`, one file per kind: a line per request, renamed aside before it is read).
  The run delivers it to `output.screens`, so only an app with a pseudo-terminal reads keys. Each
  request carries an id, and the run answers it in `send/<session>.replies/<id>`, typed or why
  not, so `send` can exit 3 rather than report keys that reached nothing.
- `commands/restart.ts` never writes the app's row: only the run knows a restart began, and it
  marks the row `starting` itself. A library `start()` records pids but reads no requests, so a
  row the command marked stayed `starting` and `restart && wait --app` hung. Like `send`, each
  request carries an id the run answers in `restart/<session>.replies/<id>`: `began` once the
  supervisor replaced the process, `failed` with why, or `not-ours` for an app it did not spawn.
  The command first waits for the request file to be taken (`dev` reads it from before its first
  app spawns, so a pid means a reader if there is one); a request nobody takes is withdrawn and
  the command exits 3. The answer waits out the app's `stopGraceMs`, since the old process
  stops before the new one spawns.
- `commands/inspect/file-table.ts` reads the machine's open-file table (`sysctl` /
  `/proc/sys/fs/file-nr`); `doctor` runs the full `lsof` for the top holders only past half full,
  because it takes seconds on a crowded machine.
- `commands/secrets.ts` is `ls` (key names and their source) and `check` (each config scope
  readable or not, with its key count). `check`'s exit codes are `SECRETS_CHECK_EXIT`, a
  contract for agents: 2 always means "log in" and wins over 3 (a scope unreadable for another
  reason), because a login may fix the rest. No subcommand prints a value, on purpose
  ([secrets](./secrets.md)). Its help keeps one usage line per subcommand, so adding `check`
  only added lines.
- `commands/sql.ts` runs the preset's own client inside the service's container through
  `interactiveExecArgv` (the one adapter method that hands back argv for inherited stdio). The
  client runs in the container, so psql's `-- -f file` is read on the host and fed to its stdin
  as bytes. Piped stdin goes to psql unread (`-f -`, so a dump of any size or encoding passes
  through as it did); `sql` reads it only for `--json`, which has to see the SQL to decide whether
  to wrap it. Grouped psql options that do their own work (`-lqt`, `-tAc`) leave stdin alone. `--json` for Postgres wraps the query in
  `json_agg` only when `sql-statements.ts` reads it, outside strings, quoted identifiers and
  comments, as one `SELECT`/`WITH` that writes nothing; anything else, or anything it cannot read
  with certainty, runs plain with a note. Wrapped, an `UPDATE` or a second statement was a syntax
  error quoting the wrapper. The user's text sits on lines of its own inside the wrapper (a
  trailing `--` comment would swallow the closing parenthesis), and psql's `LINE n:` is shifted
  back on stderr. The alias is read as `alias.*`, because a bare `json_agg(q)` aggregated a column
  named `q` instead of the row.
  `--create-scratch` always prefixes `scratch_`, so `--drop-scratch` cannot reach a database the
  project uses, and uses two `-c`s because `CREATE DATABASE` refuses the transaction one
  multi-statement `-c` becomes. It starts the database service when it is down, through the
  `run` task path (`withServices`: claim, start, release)
  with no idle hold, as `dev --up-only` leaves its containers: the command that uses the scratch
  database runs after `sql` exits, and a three-minute hold would stop it under a test suite.
  `exec --db` (`exec-database.ts`) checks the database exists with one Bun SQL query, and refuses
  when nothing points at the service's database, rather than run the command against the
  checkout's own data.
- `src/config/discover-apps.ts`: `discoverApps` marks its apps with an enumerable symbol (it
  survives spreads) for `build --discovered`.

## Check and predeploy

`commands/check/` is `buncargo check`. `planCheck` (`plan.ts`) is a pure function from the config,
the files and the mode to a list of named steps; the command reads the files and the repository
first, then filters the list (`--only`, `--skip`), prints it (`--list`) or runs it (`runner.ts`).
Step names are the filter's contract, so a chunked step (`biome --write (200 files)`) keeps one
name, and validation refuses a gate named like a built-in step or an earlier gate. `docs.ts` is
also `check docs`. Deferred tests (`check.testDeferred`) are a pass with a count by default:
a non-zero default fails every check in every repo with database tests. They used to run with no
database, every test skipped, and `check` printed `PASS`.

Steps run one at a time with their output buffered: the
point is one line per step and the tail of the failure, not a live log. The verdict is the exit
code alone and comes last, with each failure's rerun command: agents read `check | tail`, and a
format step once printed ✓ over a command that never ran. The typecheck is spawned
as `buncargo typecheck --changed` through `buncargoCli()`, so it takes a check slot and reads
`typecheck.concurrency` the same way a typecheck run by hand does; the nearby tests take no slot
(they are a handful). A root-wide file selects every gate for the reason it selects every
workspace in `typecheck --changed` (`isRootWideFile`).

`commands/predeploy.ts` runs on a deploy host, not in a checkout: it never builds an environment,
so no ports, containers or secrets, and the migrations and seed see only the host's variables.
It reuses the dev run's migration list (`migrationsFor` in `src/prisma/migrations-for.ts`)
without `requiredServices` filtering, since a deploy has no local services to select. It fails
closed: an environment no variable names is not seeded, because the default seed is the dev
run's, which in one project created a super admin with a known password on a deploy that set
neither variable. It is not in the auto-install commands: a deploy image's install layer comes
from a cache older than its `bun.lock`. Unlike `typecheck`, a config that
fails to import is an error here: migrating with half a config is worse than failing the deploy.
`loader/config-settings.ts` is the one loader for these config-only commands.

## Typecheck

`src/typecheck/typecheck.ts` runs a real process pool (`execAsync`); `scheduling.ts` is
longest-first (cached durations, then descending file count) and holds the CPU/CI concurrency
default. The CLI spec lives in `src/cli/commands/typecheck.ts` (`--concurrency`, `--only`).
`config-settings.ts` reads only the config's `typecheck` key (`include`/`exclude`, validated by
`validateTypecheckShape`) by importing the module, never building an environment; an `include`
entry with nothing to check is a failed result, not a skip. `project-tsc.ts` finds the project's
own `tsc` for both the root config and tsconfig-only includes. Do not shell out to
`bun run --filter --parallel typecheck`: Bun's workspace graph would serialize dependents.
