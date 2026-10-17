# CLI

`src/cli/bin.ts` is the executable; `src/cli/index.ts` the module entry (`buncargo/cli`: `runCli` and
`CliOptions`, nothing else). `run-cli.ts` is the dev flow; `flags.ts` (argv primitives),
`dev-flags.ts` (the dev command's typed args and help), `dev-hosts.ts` and `dev-tunnels.ts` hold the
pieces it orchestrates.

## Commands, flags and errors

- `version-guard.ts` runs first in `bin.ts`: inside a project whose `node_modules/buncargo` (the
  first found from the working directory up to the repository root) is another version, it
  `execve`s that package's `bin` with the same arguments, so the pid, stdio and signals stay the
  run's. `BUNCARGO_REEXEC` stops a second hand-over and is removed before anything starts, so
  apps never inherit it. A `package.json` listing buncargo with nothing installed is a
  `CliError`. A CLI run from `src/` is never replaced: that is someone testing the source. It
  reads files only; a matching version costs a few `stat`s.

- `command-spec.ts` is the flag-spec primitive: one `CommandSpec` per command drives parsing,
  unknown-flag detection, value validation and generated help, so those four cannot drift. Add a
  flag to the spec, not to a parallel list. `readPositionals` finds subcommands and stray
  arguments, skipping `--flag value` pairs, so no command re-walks argv itself.
- `commands/registry.ts` is the single source for top-level command names (`CliCommandName`, used
  by the `bin.ts` switch and by `help.ts`) and for the `hosts` and `bar` subcommands. Every switch
  over them ends in a `never` default.
- Failures inside a command flow throw `CliError` (`errors.ts`) so the flow can release tunnels,
  host routes and the terminal before exiting 1. Argv problems, which happen before anything
  starts, exit through `log.fail`.
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
  `.buncargo/logs/detached.log`. The parent waits on the run registry entry whose `pid` is the
  child's until every app has settled; an empty `apps` list is the claim, not "done", unless the
  selection has no app to spawn. A child that exits 0 had nothing to keep running (every app
  reused) and is a success, as it is for attached `dev`; its exit is checked before the entry,
  which can outlive it.
- `dev-flags.ts`' `destructiveModeGate`: `--reset` and `--down --all` ask in a terminal and refuse
  without one unless `--yes`. CI is exempt. An agent ran `--reset` to fix a migration and deleted a
  developer's data.
- `bar-offer.ts` is the one-question offer of the menu bar app inside `dev`, and `commands/bar.ts`
  the `install`/`status`/`open`/`uninstall`/`reset` group over `core/menubar.ts`. The offer's gates
  are checked cheapest-first and bail on two `existsSync` calls in the common case, because `dev`
  runs constantly.

## Other commands

- `commands/run.ts` is `exec` for `config.tasks` (which injects the app's secrets), with
  `requiredServices` started through `start({ onlyServices })`. It claims with the CLI's idle
  hold, not the library's keep-forever default. Extra argv goes through `withAppendedArgs`
  (`sh -c '<cmd> "$@"'`), so nothing is re-parsed. Tasks are published into the run entry for
  BuncargoBar's run button, which calls `buncargo run` *unscoped*: `--root`/`--run` name a run, and
  a task only needs the checkout (the working directory).
- `commands/ci.ts` runs on `env.withSuffix("ci")`, starts services with `onlyServices`, forces the
  seed (a CI database is never warm), runs the command and always `stop({ removeVolumes: true })`s.
  The suffix is not optional: on the shared project that teardown deletes a developer's dev
  database. A suffixed environment writes its own compose file and never persists `ports.json`, or
  it would overwrite the dev run's. `--profile` lives in `dev-flags.ts`; `selectProfileApps` in
  `run-cli.ts` turns it (or a `default` profile) into the same selection `--apps` makes.
- `agents-guide.ts` is the one copy of the agent guide (`help agents`) and the `AGENTS.md` block
  `setup --agents` keeps between `<!-- buncargo:start/end -->` markers. It lives in code, not
  `docs/`, so the guide an agent reads matches the installed version.
- `commands/ports.ts` shows the offset claims and `pin`s one: it checks every port of the block
  through `withBindProbe` and the claims before writing the lockfile and the claim. `release`
  drops another checkout's claims under the claims lock, refusing while that checkout has a live or
  held run.
- `commands/send.ts` types into an app over the same request-file channel as `restart`
  (`restart-requests.ts`, one file per kind: a line per request, renamed aside before it is read).
  The run delivers it to `output.screens`, so only an app with a pseudo-terminal reads keys. Each
  request carries an id, and the run answers it in `send/<session>.replies/<id>`, typed or why
  not, so `send` can exit 3 rather than report keys that reached nothing.
- `commands/inspect/file-table.ts` reads the machine's open-file table (`sysctl` /
  `/proc/sys/fs/file-nr`); `doctor` runs the full `lsof` for the top holders only past half full,
  because it takes seconds on a crowded machine.
- `commands/sql.ts` runs the preset's own client inside the service's container through
  `interactiveExecArgv` (the one adapter method that hands back argv for inherited stdio). `--json`
  for Postgres wraps the query in `json_agg`, so it only fits row-returning statements.
  `--create-scratch` always prefixes `scratch_`, so `--drop-scratch` cannot reach a database the
  project uses, and uses two `-c`s because `CREATE DATABASE` refuses the transaction one
  multi-statement `-c` becomes.
- `src/config/discover-apps.ts`: `discoverApps` marks its apps with an enumerable symbol (it
  survives spreads) for `build --discovered`.

## Typecheck

`src/typecheck/typecheck.ts` runs a real process pool (`execAsync`); `scheduling.ts` is
longest-first (cached durations, then descending file count) and holds the CPU/CI concurrency
default. The CLI spec lives in `src/cli/typecheck-flags.ts` (`--concurrency`, `--only`).
`config-settings.ts` reads only the config's `typecheck` key (`include`/`exclude`, validated by
`validateTypecheckShape`) by importing the module, never building an environment; an `include`
entry with nothing to check is a failed result, not a skip. `project-tsc.ts` finds the project's
own `tsc` for both the root config and tsconfig-only includes. Do not shell out to
`bun run --filter --parallel typecheck`: Bun's workspace graph would serialize dependents.
