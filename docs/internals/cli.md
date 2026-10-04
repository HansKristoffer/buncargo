# CLI

`src/cli/bin.ts` is the executable; `src/cli/index.ts` the module entry. `run-cli.ts` is the dev
flow; `flags.ts` (argv primitives), `dev-flags.ts` (the dev command's typed args and help),
`dev-hosts.ts` and `dev-tunnels.ts` hold the pieces it orchestrates.

## Commands, flags and errors

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
  `activateNamedHosts` a second time: the first attempt was refused because the other run still
  owned the hostnames, and `upsertHostRoutes` only rejects an owner that is still alive, so the
  retry succeeds once that pid is gone. Without it a takeover silently downgrades every named URL
  to `localhost:port`.
- `checks.ts` runs `SetupCheck`s (core from `core-checks.ts`, then the config's, then
  integrations'). `dev` runs only `fast !== false` ones before anything starts, not in the one-shot
  modes; warnings are printed and never stop it. `commands/setup.ts` offers each fix (`--yes` or CI
  runs them all; a terminal-less run without `--yes` only reports), then checks again. `doctor`
  lists them. A check that throws counts as failed.
- `preflight.ts` runs `config.preflight` (and integrations') after the fast checks, with the real
  terminal, filtered by each step's `apps`. A throw is a `CliError` with the step's name.
- `dev-detach.ts` is `dev --detach`: the same argv without the flag, re-run with `detached: true`
  (its own session, so a harness's SIGTERM does not reach it) and its output in
  `.buncargo/logs/detached.log`. The parent waits on the run registry entry whose `pid` is the
  child's until every app has settled; an empty `apps` list is the claim, not "done", unless the
  config has no apps.
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
  through `withBindProbe` and the claims before writing the lockfile and the claim.
- `commands/send.ts` types into an app over the same request-file channel as `restart`
  (`restart-requests.ts`, one file per kind: a line per request, renamed aside before it is read).
  The run delivers it to `output.screens`, so only an app with a pseudo-terminal reads keys.
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
