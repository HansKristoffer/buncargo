# Buncargo reference

## CLI reference

```bash
bunx buncargo dev                 # Start containers + selected apps
bunx buncargo dev api web         # Named apps plus transitive requiredApps (--apps=api,web too)
bunx buncargo dev --profile=full  # The apps of profiles.full
bunx buncargo dev --no-tui        # Prefixed lines instead of the terminal UI
bunx buncargo dev --detach        # In the background; returns once the apps are up
bunx buncargo dev --detach --keep # Same, without the 2-hour idle limit
bunx buncargo dev --detach --json # Same, the outcome as one JSON document
bunx buncargo dev --no-watch      # Ignore the apps' watch config for this run
bunx buncargo dev --attach=expoApp
bunx buncargo dev --expose
bunx buncargo dev --expose=api
bunx buncargo dev --up-only
bunx buncargo dev --migrate
bunx buncargo dev --seed
bunx buncargo dev --down
bunx buncargo dev --down --all    # Remove every buncargo env you started on this machine
bunx buncargo dev --reset
bunx buncargo dev --reset --yes   # Without a terminal, --reset and --down --all need --yes
bunx buncargo dev --takeover        # Stop apps running elsewhere, run them here
bunx buncargo dev --keep-containers
bunx buncargo dev --replace-stale   # First remove this checkout's stacks under an old projectPrefix (keeps volumes)
bunx buncargo dev --watchdog-timeout=5
bunx buncargo dev --no-docker-autostart
bunx buncargo dev --no-hosts
bunx buncargo dev --runtime=apple  # Run services on Apple container
bunx buncargo dev --timing         # Entry through app readiness, including preparation
bunx buncargo dev --timing-json    # Same measurements and numeric counters as JSON
bunx buncargo dev expoApp -- --clear
bunx buncargo ls
bunx buncargo runs                # What is running on this machine
bunx buncargo runs --json         # Same, machine-readable
bunx buncargo stop api            # Stop one dev server
bunx buncargo stop postgres       # Stop one service's container
bunx buncargo stop --all          # Stop this checkout's whole run
bunx buncargo stop                # Same as stop --all
bunx buncargo restart shopify     # Start a stopped app of a running dev again
bunx buncargo logs                # Every app's output from the current or last run
bunx buncargo logs shopify --errors -f --since=5m
bunx buncargo expo sim            # Open the Expo app in this checkout's own simulator
bunx buncargo status              # One line per app first, then ports, containers and hosts
bunx buncargo status --json       # The same as one object, its live runs (app states) first
bunx buncargo sql                 # psql (or clickhouse-client) in this checkout's container
bunx buncargo sql -c "select count(*) from users" --json
bunx buncargo sql redis -c "GET key"
bunx buncargo sql --create-scratch=migcheck   # Empty scratch_migcheck; prints its URL
bunx buncargo sql --drop-scratch=migcheck
bunx buncargo sql --db=scratch_migcheck -c "select 1"   # An existing database, as it is
bunx buncargo sql --db=scratch_migcheck --url  # Its URL
bunx buncargo sql -- -tA -f query.sql          # psql flags after --; -f reads a host file
bunx buncargo ports               # This checkout's ports, and every checkout's offset
bunx buncargo ports pin 2500      # Keep this checkout on offset 2500
bunx buncargo ports release --root ../old-worktree   # Drop another checkout's claims
bunx buncargo ports release --idle=7d   # Free the blocks of checkouts not started for a week
bunx buncargo send expoApp i      # Type into an app that has a terminal of its own
bunx buncargo doctor
bunx buncargo doctor --fix
bunx buncargo hosts install
bunx buncargo hosts install --force   # Also replace a newer daemon another project installed
bunx buncargo hosts status
bunx buncargo hosts sync
bunx buncargo hosts prune
bunx buncargo hosts daemon      # Run the proxy in the foreground
bunx buncargo hosts uninstall
bunx buncargo bar install         # Install the macOS menu bar app
bunx buncargo bar status
bunx buncargo env
bunx buncargo env --get ports.api
bunx buncargo env --get DATABASE_URL   # Any variable the apps get
eval "$(bunx buncargo env --export)"   # All of them, as shell exports
bunx buncargo env set REDIS_URL=http://localhost:8779   # Override one for this checkout
bunx buncargo env unset REDIS_URL
bunx buncargo url                 # Every URL this run knows, by name: apps, services, captures
bunx buncargo url postgres        # A service's URL; its connection URL when it has no HTTP one
bunx buncargo url api --local     # The URL for a browser on this machine, whatever BUNCARGO_URL_HOST says
bunx buncargo open                # The primary app; or `open <name>` from `url`
bunx buncargo open shopify previewUrl  # An app's captured URL (what its action key opens)
bunx buncargo exec -- bun scripts/maintenance.ts
bunx buncargo exec --app=api -- bun scripts/inspect-runtime.ts
bunx buncargo exec --db=scratch_migcheck -- bun test   # Database URLs point at another database
bunx buncargo prisma <args>
bunx buncargo prisma migrate-check  # Fail when migrations and schema differ
bunx buncargo prisma migrate reset --yes  # Destructive: needs --yes without a terminal
bunx buncargo prisma migration new add_orders  # Write a migration and print its path, no terminal needed
bunx buncargo prisma migration check  # Fail on migration timestamps out of order with the base branch
bunx buncargo prisma --db=scratch_migcheck migrate deploy  # Against a scratch database
bunx buncargo wait --app=api --hold   # Block until an app is healthy (and stay)
bunx buncargo generate            # Render generatedFiles without starting anything
bunx buncargo build --discovered  # Every discovered app's build, in order
bunx buncargo secrets ls --app=api   # Key names and their source, never values
bunx buncargo secrets check --json   # Is every Infisical scope readable? Exit 2: log in
bunx buncargo files status        # Each checkout file: in sync, local edits, ...
bunx buncargo files save          # This checkout's copies to the file store
bunx buncargo files pull --force  # The file store to this checkout, over local edits
bunx buncargo files diff .env.local  # Keys that differ, never values
bunx buncargo files merge .env.local # Your edits and the store's changes, key by key
bunx buncargo files export | ssh box 'cd app && bunx buncargo files import'
bunx buncargo shopify env         # An integration's own commands
bunx buncargo shopify login       # Log the Shopify CLI in
bunx buncargo shopify link --config=local  # Link a toml without losing it
bunx buncargo run                 # List tasks
bunx buncargo run db:seed -- --dry-run
bunx buncargo setup               # Run the fix of every failing check
bunx buncargo setup --agents      # Keep a buncargo block in AGENTS.md
bunx buncargo ci --migrate --seed -- bun test
bunx buncargo typecheck
bunx buncargo typecheck --changed  # What this branch can break
bunx buncargo typecheck --group=web  # One typecheck.groups selection (a CI job)
bunx buncargo check               # Biome, typecheck, gates and nearby tests for this branch
bunx buncargo check --staged      # The pre-commit hook: staged files, no writes
bunx buncargo check --all         # Every check but the tests (lint)
bunx buncargo check docs          # Only Markdown links and documented commands
bunx buncargo check --list --json # The steps this change would run, by name
bunx buncargo check --skip=typecheck  # Every step but these (--only=<names> for just these)
bunx buncargo predeploy           # Before a deploy: migrate, then seed when predeploy.seed says so
bunx buncargo slot -- bun test      # A heavy command in a check slot
bunx buncargo help
bunx buncargo help agents         # The guide for AI agents working in a checkout
bunx buncargo help agents db      # One topic of it (`all` prints every topic)
bunx buncargo help agents exits   # Every command's exit codes and JSON documents
bunx buncargo version
```

Every command takes only what its `--help` lists, and exits 1 naming anything else: an unknown flag, a
value on a flag that takes none (`--detach=1`), a flag that needs a value given without one (`dev
--profile`), a flag given twice, or an argument too many. A value that starts with `-` is written with
`=` (`--command=-1`). A flag with an optional value takes it only after `=`: `dev --expose=api` exposes
`api`, while `dev --expose api` exposes every `expose: true` target and starts only `api`. `-h` and
`--help` print a command's options and exit codes on every command and subcommand (`files pull --help`),
whatever else is on the line. `buncargo help agents exits` lists the exit codes beyond 0 and 1 for
every command, and the JSON documents they print.

Inside a project, the CLI runs the project's own buncargo. When `bunx buncargo` reaches a
different version (a global install, because the checkout has no `node_modules/.bin`), it prints
one line and hands over to the version in the project's `node_modules`, with the same arguments.
A checkout without `node_modules` (a fresh worktree) installs itself before any command, and one
whose `bun.lock` changed since its last install (a branch switch) before a command that runs the
project (`dev`, `run`, `exec`, `slot`, `prisma`, `build`, `generate`, `typecheck`, `check`, `ci`,
`setup`; never `stop`, `status`, `logs`, `predeploy` or the menu bar's buttons): the CLI prints one
line, runs `bun install --frozen-lockfile` (the project's postinstall scripts included, its
output on stderr so `--json` stays clean), and then runs the command. When that install fails, it stops with the
install's output and asks for `bun install`. A project without `bun.lock` whose `package.json`
lists buncargo but has none installed stops and asks for `bun install` instead of running a
version the project did not choose.

`buncargo env` prints JSON (`portOffset`, `portOffsetProvenance`: `hash` | `claim` | `env` | `shifted` | `unallocated`), including `vars`: the variables `exec`, tasks and the apps are given, without their Infisical secrets. `--get ports.api` prints one raw value for scripts, and a bare name (`--get DATABASE_URL`) reads from `vars`. `--export` prints `vars` as quoted `export` lines.

`buncargo dev --detach` starts the run in its own session, with its output in `.buncargo/logs/detached-<pid>.log` (`.buncargo/logs/detached.log` links to the newest run's) and the apps' in their run directory, and returns once every app has come up or failed: exit 0 when all are up, or when every selected app already runs elsewhere and is reused (attached `dev` exits 0 on that too); 1 when one is not up (the others keep running) or the run failed; 2 when apps are still starting after 10 minutes (the run keeps going; `buncargo wait --app=<app>` waits on). The log of the last detached run that ended is kept until a later one has ended too. A failure ends the output with one block: what failed in one line (the app, the seed or the step), its last 20 lines of output, the setup checks that warned before the start, and what to run next (`buncargo logs <app>`), so `dev --detach | tail` shows the cause. Attached `dev` ends a failed start with the same block. Stop it with `buncargo stop`: a detached run is recorded as such, so `stop` does not ask for confirmation the way it does for a run in another terminal. It is the way to run `dev` from an agent or a script. `dev --detach --json` prints the outcome as one JSON document instead, with the same exit code: `{ version: 1, outcome: "up" | "finished" | "failed" | "timeout", exitCode, pid, log, apps: [{ name, status, url }], hostsWarnings, failures, idleLimitMs }`. `hostsWarnings` says why named URLs fell back to `localhost:port`, which the run reports itself; `failures` holds each failure block (`cause`, `step`, `output`, `hints`, `next`).

A detached run stops by itself after 2 hours idle: no request through buncargo's named-hosts proxy to this checkout, no open connection to one of its apps' ports (a browser tab's HMR socket, a client on `localhost:port`), and no `buncargo` command run in it. `buncargo runs` and `ls` show the time left (`runs --json` gives it as `idleStopsAt`), and once the watchdog has stopped a run, `stop` and `ls` say so and why. While a `dev` in a terminal runs in the same checkout, the detached run is left alone, since that run may be serving from its apps. `dev --detach --keep` turns the limit off. Tailscale mode (`BUNCARGO_HOSTS=tailscale`) gives detached runs no limit. When neither the hosts daemon's request counts nor the machine's open connections can be read, the limit is not enforced; with named hosts on, `buncargo hosts install` updates a daemon too old to count requests. A detached run whose checkout has been deleted for 10 minutes is stopped too, `--keep` or not. A run in a terminal is never stopped either way.

`buncargo sql --create-scratch=<name>` drops and recreates an empty Postgres database `scratch_<name>` in this checkout's container and prints its URL alone on stdout, so `DATABASE_URL=$(buncargo sql --create-scratch=migcheck) bun test` works. When the database service is down, it starts that one service first (no apps, no other services), and leaves it running as `dev --up-only` does. `--drop-scratch=<name>` drops it. The prefix is always added, so neither can touch a database the project uses. A scratch database lives in the checkout's volume: `dev --reset` and `prune` remove it with the rest.

`buncargo sql [service]` runs the service's own client inside this checkout's container, with the credentials from the config: `psql` for Postgres, `clickhouse-client` for ClickHouse, `redis-cli` for Redis. Without a service it picks the first Postgres or ClickHouse one. `-c <query>` runs one query. Without `-c`, SQL piped on stdin or in a heredoc runs as a script that stops at the first error, with a non-zero exit. Arguments after `--` go to the client (`-- -tA`, `-- -v ON_ERROR_STOP=0`); psql's `-f <file>` reads the file on the host and feeds it in, since the client runs in the container (an `-o` file or `\i` would be the container's). `--db=<database>` connects to another database of this checkout's Postgres without touching it (a scratch database is `scratch_<name>`), and `--url` prints the URL of that database, or of the service's own, without connecting.

`--json` prints the rows of one `SELECT` or `WITH` query as a JSON array (Postgres) or JSON lines (ClickHouse), from `-c`, `-f` or stdin. Postgres SQL that is not a single row-returning query (an `UPDATE`, several statements, a psql meta-command) runs as plain SQL instead, with a note on stderr. Errors quote your own SQL and line numbers.

When the database is not running, `sql` exits 1 and says to start it with `buncargo dev --up-only`, which returns once the containers are up and needs no `--detach`.

Without a terminal, `dev --reset` (which deletes the checkout's volumes) and `dev --down --all` (which stops every checkout's run) refuse unless `--yes` is passed; in a terminal they ask first. CI is exempt.

`buncargo help agents` prints a short guide for AI agents working in a checkout: the rules, the commands to use and what to do when something fails, under 40 lines. `buncargo help agents <topic>` prints one topic in full (`start`, `runs`, `env`, `db`, `ports`, `logs`, `check`, `files`, `share`, `fail`, `config`), and `help agents all` all of them. `buncargo setup --agents` adds (or updates) a short block in the project's `AGENTS.md` that states the rules agents most often miss and points at the guide.

`buncargo typecheck` runs each workspace's own `typecheck` script in parallel (longest job first), plus the root `dev.config.ts` on its own - that file belongs to no workspace, so nothing else checks it. Default concurrency is the CPU count, capped at 4 locally and in CI at one process per 3.5 GB of memory (2 on a 7 GB runner, the CPU count on a large self-hosted machine); override with `--concurrency=N`, then `BUNCARGO_TYPECHECK_CONCURRENCY`, then `typecheck.concurrency` in the config, in that order, so a CI runner sizes itself over the config's local value. `--only=platform` (path or basename) checks one workspace. `--changed[=<ref>]` checks only what the branch can break: the workspaces holding files changed since the merge base with `<ref>` (default `origin/HEAD`, then `origin/main`, then `main`), committed, uncommitted, untracked or deleted, plus every workspace that depends on one of them through `package.json`, transitively. A root `package.json`, lockfile, `tsconfig*.json` or `dev.config.ts` among them checks everything, the root config included; otherwise the root config is skipped.

A typecheck holds one of the check slots while it runs (`BUNCARGO_CHECK_SLOTS`, default 3, `0` turns the cap off). The slots are shared by every checkout of one user on the machine, in `~/.buncargo/check-slots/`. Coding agents in many worktrees otherwise start several native `tsc` runs at once, each peaking at several GB, and run the machine out of memory. A typecheck that finds every slot taken prints who holds them and its place in line, and waits for up to 15 minutes, repeating that line every 30 seconds; past that it runs without a slot and says so. `buncargo status --json` shows the slots as `checkSlots`: the capacity, the holders and how many checks wait. A slot is a kernel lock on a file, so a killed holder's slot frees at once. `buncargo slot -- <command>` takes a slot for any other heavy command, such as a test suite, and runs it with the shell's own environment; `exec --slot` does the same with the checkout environment added. Their children see `BUNCARGO_CHECK_SLOT`, so a `buncargo typecheck` inside does not wait for a second slot. CI takes no slot. The config run generates `.buncargo/config-typecheck.tsconfig.json` and records durations in `.buncargo/typecheck-timings.json`; keep `.buncargo/` in `.gitignore`.

Workspaces are discovered from the root `package.json` `workspaces` (else `apps/*`, `packages/*`, `modules`), keeping those whose `package.json` has a `typecheck` script. `typecheck` in `dev.config.ts` changes that set:

```typescript
typecheck: {
	include: ["scripts", "tools/*"], // checked beside the discovered workspaces
	exclude: ["legacy", "packages/old-*"], // left out: path, glob or basename
},
```

`include` takes directories relative to the root, globs allowed: a root `scripts/` folder, a package outside `workspaces`. Each runs its own `typecheck` script when its `package.json` has one, else `tsc --noEmit -p tsconfig.json` with the project's TypeScript. An entry that matches no directory, or a directory with neither a script nor a `tsconfig.json`, fails the typecheck instead of being skipped. `exclude` removes workspaces, discovered or included, by path, glob or basename (like `--only`). Both are validated with the config; absolute paths and paths leaving the root are rejected. `buncargo typecheck` reads only this key of the config module, without building an environment; a config that fails to import is a warning there, since its own typecheck reports the problem.

`typecheck.scripts` names the `package.json` scripts that check a workspace, as in `scripts: ["typecheck", "typecheck:e2e", "typecheck:node"]` (default `["typecheck"]`). A workspace with any of them is discovered, and each one it has is its own job in the pool, `--changed` and the check slot, reported as `apps/web#typecheck:e2e` after the first script.

`typecheck.concurrency` sets the default `--concurrency`. `typecheck.groups` names selections for `--group=<name>`, so CI can split the check across runners without listing workspaces; a new workspace joins the group that excludes rather than lists:

```typescript
typecheck: {
	concurrency: 2,
	groups: {
		platform: { only: ["platform"], rootConfig: false },
		rest: { exclude: ["platform"] }, // everything else, the root config included
	},
},
```

From code, `runWorkspaceTypecheck(options)` (exported from `buncargo`) runs the same checks and resolves to a `TypecheckResult`; it takes the flags above as `concurrency`, `only`, `changedFiles`, `include` and `exclude`. Pass `signal` (an `AbortSignal`) to cancel a run: the checks it started are terminated with their child processes, none is started after, and the promise rejects with the abort reason. `buncargo typecheck` does this on Ctrl-C or `SIGTERM` and exits 130 or 143.

## Execute with the checkout environment

Use `exec` for maintenance scripts and tooling that need the checkout's allocated
URLs and environment:

```sh
bunx buncargo exec -- bun scripts/maintenance.ts
bunx buncargo exec --app=api -- bun scripts/inspect-runtime.ts
bunx buncargo exec --cwd=packages/prisma -- bun seed.ts --profile=internal
```

Shared generated values are always available. `--app` adds that app's environment
overlay and uses its configured directory; otherwise the working directory is the
repository root. An explicit relative `--cwd` resolves from that root, including
when the command is launched inside a workspace.

`--db=<name>` points every variable whose URL names this checkout's Postgres
database (same host, port and database, such as `DATABASE_URL` and a
`DATABASE_URL_DIRECT`) at database `<name>` on the same server, keeping the
user, password and query string; a shadow database's URL keeps its own. The
database must exist: `buncargo sql --create-scratch=<name>` makes one, as
`scratch_<name>`. The rewritten names go to stderr. With nothing to rewrite, or
the database missing, `exec` exits 1 without running the command.

`--slot` runs the command inside one of the check slots (see
[typecheck](#cli-reference)), for checks heavy enough to crowd out other
checkouts that also need the checkout's URLs or secrets. A command that must
not see them, such as a unit test suite that mocks Redis unless `REDIS_URL` is
set, takes its slot with `bunx buncargo slot -- bun test` instead, which adds
nothing to the environment.

The required `--` separates buncargo options from unchanged child arguments.
Invoke a shell explicitly for shell syntax, for example `-- sh -c 'command1 && command2'`.
Standard streams, interrupt signals and the child's exit status propagate to the
caller. Exec does not start apps or infrastructure, migrate, generate, or seed.

Exec and environment reads reuse persisted checkout ports without probing
running services as foreign occupants. On a cold checkout, they compute a
deterministic allocation without starting infrastructure or writing the allocation;
those endpoints are a preview until `dev` resolves conflicts and persists them.
Read-only commands retain existing persisted endpoints across base-port edits;
new keys use the persisted offset until startup reconciles. `buncargo prisma`
starts the database, so it allocates and claims the block first, as `dev` does.
An explicit `BUNCARGO_PORT_OFFSET` overrides allocation.

Programmatically, `env.exec(["bun", "scripts/maintenance.ts"], { app: "api", cwd: "." })`
uses the same environment and directory rules. String commands use a shell; argv
arrays preserve each argument. It returns `{ exitCode, stdout, stderr }` and throws
on failure unless `throwOnError: false` is supplied.

## Checks, tasks and profiles

```typescript
import { defineDevConfig, exists, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "shop",
	services: { postgres: service.postgres() },
	apps: {
		shopify: { port: 3000, devCommand: "bun run dev", cwd: "apps/shopify" },
		api: { port: 4000, devCommand: "bun run dev", cwd: "apps/api", requiredServices: ["postgres"] },
		forecastService: { port: 4100, devCommand: "bun run dev", cwd: "apps/forecast" },
	},
	setupChecks: [
		{
			name: "GraphQL types",
			check: () => exists("packages/shopify-admin-graphql/graphql/generated"),
			fix: "bun run graphql-codegen",
		},
	],
	tasks: {
		"shop:seed": {
			command: "bun scripts/shop-seed.ts",
			description: "Seed the dev store",
			app: "api",
			requiredServices: ["postgres"],
		},
	},
	profiles: {
		default: { apps: ["shopify"] },
		full: { apps: ["shopify", "forecastService"] },
		api: { apps: ["api"] },
	},
});
```

**Setup checks** (`setupChecks`) are preconditions of the checkout. `buncargo dev` runs the fast ones before it starts anything and stops with each failing check's fix, instead of failing deep inside whichever app imports the missing file first. `buncargo setup` runs all of them: core checks (Bun matches `.bun-version`, the container runtime is up, `.buncargo/` and `gitignore: true` generated files are ignored, Infisical is readable, the Prisma client matches the schema), then the config's, then the integrations' (Shopify: CLI version, login, link, `web_directories`, tomls agreeing). It offers each fix in turn, runs them all with `--yes` or in CI, and checks again. It is idempotent. `buncargo doctor` lists them too. A check returns `true`, `false` or `{ ok, detail }`; `fix` is a command or a function; `fast: false` keeps an expensive check out of `dev`; `severity: "warning"` reports without failing. A check that throws counts as failed. `exists(path)` resolves against the monorepo root, whatever directory `dev` was started from.

**Tasks** are the one-off scripts a project accumulates. `buncargo run shop:seed` is `exec` with that app's env, secrets and working directory, after starting `requiredServices` (and their Compose dependencies) if they are down. Services a task starts are held on the same idle timer as a `dev` run's. Arguments after `--` are appended to the command without being re-parsed by the shell. `buncargo run` alone lists the tasks, `buncargo help` shows them too, and BuncargoBar puts a run button next to each one.

**Profiles** replace a `dev:*` script per combination of apps. `buncargo dev --profile=full` runs that profile's apps, exactly like `--apps=shopify,forecastService`. A profile named `default` is what a bare `buncargo dev` runs; without one, `dev` runs every app as before. `--profile` and `--apps` cannot be combined.

## `buncargo check` and `buncargo predeploy`

`buncargo check` is one check for the change in front of you. It runs `bun fmt` on the changed files when `check.format` is set, Biome (`--write`) on the changed files when the root has a `biome.json`, the docs check when a Markdown file changed, `buncargo typecheck --changed`, the config's gates, and the tests beside the changed files (`a.ts` → `a.test.ts`, `a.*.test.ts`). It prints one line per step and the tail of a failing step's output, then `PASS`, or `FAIL: <steps>` followed by one line per failed step with its exit code and the command to rerun it, so the end of the output (`| tail`) holds the whole verdict. A step passes only on exit code 0: one killed by a signal, or that cannot start at all (`E2BIG`, a missing binary), fails. The exit code is 1 when any step failed. "Changed" means since the merge base with `origin`'s default branch (or `--base=<ref>`), committed or not, plus untracked files. `--staged` checks the staged files only, writes nothing and runs no tests: the pre-commit hook. `--all` checks every file, workspace and gate, without tests: `bun run lint`.

Each step has a name: `bun-version`, `format`, `biome`, `docs`, `typecheck`, a gate's `name`, and `tests`. `--list` prints the steps the change selects without running them (`--json` for one document with each step's name, label and command, and the deferred tests); `--only=<names>` and `--skip=<names>` (comma-separated) run a subset, so a CI job can run the typecheck on its own runner and `check --skip=typecheck` on another. A name that is neither built in nor a gate is an error. Under GitHub Actions each step is a collapsed `::group::`, a failed step prints its whole output, and an `::error` annotation names the step and the command to rerun it. Elsewhere a failed step prints its last 80 lines, and a failed `bun test` prints each failed test with its error and the totals.

When the checkout has a `.bun-version`, a different Bun fails the check with `check.format` set (`bun fmt` formats differently across versions) and is a warning otherwise.

```typescript
check: {
	gates: [
		{ name: "i18n", command: "bun run i18n:check", when: ["**/locales/**"] },
		{ name: "web boundary", command: "bun run check:boundary", cwd: "apps/web", when: ["apps/web/**", "packages/**"] },
		{ name: "codegen", command: "bun run gen --check", staged: false },
	],
	testCommand: "bun test --parallel=4 --isolate", // default: bun test
	testExclude: ["**/e2e/**"],
	format: ["**/*.{ts,tsx,vue}"], // bun fmt; true for every file it knows
	testAlso: [{ when: ["apps/api/src/routes/**"], tests: ["apps/api/test/routes.test.ts"] }],
	testDeferred: { files: ["**/*.database.test.ts"], command: "bunx buncargo ci -- bun test" },
},
```

`testAlso` runs tests that guard files they do not sit next to: a changed file matching `when` adds the `tests` (paths or globs). `testDeferred` names tests that need services, such as a database: `check` selects them as usual but does not run them, and ends with `PASS, 1 test file not run` and the command that runs them (`command`, default `testCommand`, followed by the files). The exit code stays 0; `strict: true` makes it `FAIL` and 1.

`check.format` formats with Bun's own formatter (`bun fmt`, Bun 1.4.4 or newer, configured in `bunfig.toml` `[fmt]`) and leaves Biome to lint: turn Biome's formatter off (`"formatter": { "enabled": false }`). `true` formats every file `bun fmt` knows; globs limit it, as in `format: ["**/*.{ts,tsx,vue}"]`. The default mode writes the changed files that match, `--staged` only checks the staged ones, and `--all` runs `bun fmt --check` over the repo. It runs from the root, so `.prettierignore` applies even to the files passed by name.

A gate runs when a changed file matches one of its `when` globs, or always without `when`; a change to a root manifest, lockfile, `tsconfig*.json` or `dev.config.ts` selects every gate. `staged: false` keeps a slow gate out of the pre-commit hook, and `rootWide: false` keeps a gate with `when` from running on a root file change. A gate's `fix` (a shell command, as in `{ name: "codegen", command: "bun run gen --check", fix: "bun run gen" }`) runs when the gate fails in the default mode, and the gate is checked again; `--staged` and `--all` only report. `check.docs: false` turns the docs check off; `check.docs: { paths: true }` adds backticked paths to it (see below). `buncargo check docs` runs only that check over every Markdown file, and ends with `✓ docs: <n> files, 0 problems`: relative links whose target does not exist (anchors, URLs, code fences and `{{...}}` placeholders are skipped), and a `bun --cwd` command with `run` after the directory, which Bun parses as a run with no script and exits 0 on (write `bun run --cwd <dir> <script>`).

With `paths`, it also reports a backticked path whose first segment is a directory at the root and that exists neither from the root nor from any folder between the root and the doc. Extensionless module paths, `:line` and `#anchor` suffixes, globs, placeholders (`<name>`, `{x}`, `...`) and gitignored outputs pass. List the paths meant to be missing:

```typescript
check: {
	docs: {
		paths: {
			exempt: [
				{ file: "docs/integrations/other-repo.md", reason: "paths in another repository" },
				{ file: "**", path: "docs/adr", reason: "created with the first decision" },
			],
		},
	},
},
```

`buncargo predeploy` is the one-off step a host runs before each deploy (Railway's `preDeployCommand`). It applies the migrations a dev run applies (`prisma migrate deploy` in `prisma.cwd`, then `migrations`), then seeds only when `predeploy.seed` says so: a command runs from the root, and `true` runs the dev `seed.command` (and fails before migrating when there is none). Without `predeploy.seed` nothing is seeded, and predeploy says so. It reads the config module only, and runs everything with the deploy's own environment: no ports, containers or buncargo secrets. The environment is the first of `SECRETS_ENV` and `NODE_ENV` that is set. With neither set it is `dev` and is not seeded, and predeploy says so; `prod` and `production` are never seeded, and with `predeploy.seedIn` only the environments it lists are. It never installs dependencies first, even when `bun.lock` is newer than `node_modules`.

When Prisma reports a migration it recorded as failed (P3009, or P3018 as it fails), predeploy names it and prints the command that unblocks later deploys, which otherwise all stop at the same migration: `bunx prisma migrate resolve --rolled-back <name>` once what it applied is undone, or `--applied <name>` if it was finished by hand. `predeploy.onFailure` runs when any step fails, before the deploy exits nonzero; it gets the context and `{ step, migration?, message, failedPrismaMigration? }`. A migration refused with Postgres's "remaining connection slots are reserved" is retried every 15 s, up to 20 times: on a small instance the previous deploy's pool and a sibling service's pre-deploy can hold every slot for a few minutes.

```typescript
predeploy: {
	environmentVars: ["APP_ENV"], // default: ["SECRETS_ENV", "NODE_ENV"]
	production: ["live"], // default: ["prod", "production"]
	seed: "bun run seed --allow-remote", // or true for seed.command; default: no seed
	seedIn: ["staging", "preview"], // default: every named environment outside production
	retry: { attempts: 10, delayMs: 30_000 }, // or false
	afterMigrate: async ({ production, exec }) => {
		if (!production) await exec("bun scripts/backfill.ts", { cwd: "apps/api" });
	},
	onFailure: async (ctx, failure) => {
		await ctx.exec(`bun scripts/alert.ts "${failure.step}: ${failure.message}"`);
	},
},
```

`beforeMigrate`, `afterMigrate` and `afterSeed` get `{ root, environment, production, exec }`.

## CI

```yaml
- uses: actions/checkout@v5
- uses: HansKristoffer/buncargo/actions/setup@main
- run: bunx buncargo ci --migrate --seed -- bun test
- run: bunx buncargo ci --migrate-check
```

`buncargo ci [--migrate] [--seed] [--schema=push] [--migrate-check] [--services=a,b] [--apps=a,b [--build]] [--slot] -- <command>` starts the configured services (all of them, or `--services`), applies migrations and the seed with the same config as local, runs the command with the checkout env (but no Infisical secrets: a CI job should not need Infisical access for its tests; migrations and the seed keep their scopes), and tears everything down. A PR workflow then needs no `services: postgres` block or hand-written `DATABASE_URL`, and "migrations apply" and "the seed works" are tested exactly as they run locally. Without a command it only prepares; the exit code is the command's, or the seed's when that fails. Its own progress, and what Prisma generate and the seed print, goes to stderr, so stdout is the command's. `seed.check` is skipped, because a CI database is never warm.

Every run is a stack of its own: `<project>-ci-<id>`, with a new id each run, and on a self-hosted GitHub Actions runner (`RUNNER_ENVIRONMENT=self-hosted`) the runner's name after it, `<project>-ci-<id>-<runner>`. It has its own ports and compose file, so two runs in one checkout never share a container or a database, and running it on a laptop never touches the checkout's dev database. On Docker each service publishes on a port Docker picks (`127.0.0.1::5432`), and the URLs, migrations, the seed and the command get the ports read back once the containers are up. Apple `container` cannot pick one, so there the run keeps the ports of its own claimed block. A port the config spells out in a raw service's `ports` stays as written. Services keep their data in memory (tmpfs) instead of volumes, so a run leaves no database behind however it ends. Bind mounts and `external` volumes stay as configured.

`--schema=push` applies the Prisma schema with `prisma db push` instead of replaying the migrations, for a test shard that needs the tables and not their history. It implies `--migrate`: the push takes the place of `migrate deploy`, and the other `migrations` entries, `prisma.generate` and the `beforeMigrations` and `afterContainersReady` hooks run as they do with `--migrate`. A failed push fails the run with exit 1. Keep `--migrate` in the job that checks the migrations apply.

`--migrate-check` runs `buncargo prisma migrate-check` (below) inside the run's own stack, after the services start and before the command: the shadow database lives in that stack and goes with it, and the checkout's dev database is never started. It exits 2, without running the command, when the schema has changes no migration contains, and 1 when the check itself fails.

`--apps=api,web` starts those apps (and their `requiredApps`) once the services are prepared, waits until each passes its health check, then runs the command; the apps stop with the stack. With `--build`, each app's `buildCommand` runs first and the app starts with its `prodCommand` (its `devCommand` when it has none) and the production env, which is what an E2E job tests against. A build that fails, or an app that exits or misses its health check, fails the run with exit 1 before the command runs. `--build` needs `--apps`.

`--slot` takes one of the machine's check slots, as `buncargo slot` does, before the services start, and holds it until the stack is down, so agents running test suites in many worktrees wait their turn instead of each starting a database at once. Like every slot, it does nothing in CI.

The teardown runs however the run ends: the command failing, the services failing to start, or `SIGINT`/`SIGTERM`/`SIGHUP` at any point, including one that arrives while the stack is already coming down. An interrupted run exits `130`/`143`/`129`. Only a run killed outright (`SIGKILL`) leaves its stack: the sweep (the watchdog, `ls`, `doctor`) removes its containers once it has seen the run gone for 15 seconds. `ci` starts no watchdog of its own: on a machine where no other run started one, the next `ls` or `doctor` sweeps.

`buncargo prisma migrate-check` wraps `prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma --exit-code` against a shadow database. The shadow database (`<database>_shadow`) is created inside the configured Postgres service, so no host `psql` is needed. Prisma 6 and older get it as `--shadow-database-url` (and `--to-schema-datamodel`, their name for the flag). Prisma 7 removed that flag and reads the shadow URL from `prisma.config.ts`, so point `datasource.shadowDatabaseUrl` at `env("SHADOW_DATABASE_URL")`, which buncargo sets. `--migrations=<dir>` and `--schema=<path>` override the paths (relative to `prisma.cwd`), and arguments after `--` go to `migrate diff`. Exit code 2 means the schema has changes no migration contains.

`buncargo prisma migration new <name>` writes the migration `migrate dev --create-only` would, without a terminal: it diffs the migrations against `prisma.schema` on a database it creates in the Postgres service and drops afterwards, writes `<timestamp>_<name>/migration.sql` with a timestamp after every existing migration, and prints the folder's path, alone on stdout. When the schema has nothing new it writes nothing and exits 1; `--empty` writes an empty migration to fill in by hand. Prisma 7 reads the shadow database from `prisma.config.ts`, as for `migrate-check`.

`buncargo prisma migration check` fails (exit 1) when two migrations share a timestamp, or when a migration the base branch lacks sorts before the newest migration on it: branches that each added a migration in parallel produce both, and a database already at the base's tip applies them out of order. The base is the remote's default branch (else `origin/main`, else `main`); `--base=<ref>` names another. It reads only git and the migration folders: nothing starts.

The `actions/setup` composite action installs Bun from `.bun-version` (or `bun-version`), restores a cache keyed on `bun.lock` and the Bun version, and runs `bun install --frozen-lockfile`. The cache covers the Bun store and every workspace's `node_modules` (`apps/*`, `packages/*`, `extensions/*` by default; set `node-modules` to change it), because the isolated linker puts links in each workspace and a root-only cache never skips the install.

## Integrations

Project-type knowledge lives in integrations rather than in every project's scripts: `buncargo/shopify`, `buncargo/expo`, `buncargo/supabase` and `buncargo/firebase` today. An integration is a plain object in `integrations: [...]`. It can transform the config (add apps, env, generated files), run a stack of containers another CLI manages (`stacks`), add hooks and checks, contribute commands under its own name (`buncargo shopify env`), add env to one app's process, and describe itself in `buncargo env`, the run registry and BuncargoBar. [`docs/integrations.md`](../docs/integrations.md) covers writing one, with the Shopify and Expo integrations as references.

Run `bun run benchmark:startup` for the regression matrix: cold and warm service starts, four concurrent runs, app-only selections, port allocation, workers, preparation, shared-checkout reuse, and cancellation. Results, violations and warnings are saved to `.buncargo/benchmarks/startup.json`, including failed runs. Each scenario in `scripts/startup-budgets.ts` has a contract and a timing budget. The contract fails the run: the phases every sample reports, and a per-platform ceiling on the subprocesses one run forks. Timings over budget only warn, since they move with the load on the machine; for example, single-run warm startup has a 700ms budget, shared-checkout reuse 350ms, and cancellation 300ms. CI takes five samples per worker and applies `--budget-scale=1.5` to the timing budgets. Counters include process identity subprocesses. These measure orchestration overhead with simulated containers; they do not include image pulls or external network providers. The fixture owns its watchdog sentinel and isolates both container binaries.

For smaller regressions, compare with a saved successful run on the same platform and Bun version using `--baseline=path/to/startup.json`. A timing past the default allowance of 25% or 50ms, whichever is larger, warns; `--max-regression-percent` changes the percentage. Explicit `--max-p95` and `--max-cold-p95` override the timing budgets, and `--max-subprocesses` the subprocess ceiling. Capture a baseline on the same machine under similar load.

```sh
bun scripts/benchmark-startup.ts --scenario=allocation --parallel=4 --apps=2
bun scripts/benchmark-startup.ts --scenario=reuse --same-checkout --parallel=4
bun run benchmark:startup --samples=10 --baseline=.buncargo/benchmarks/baseline.json
```

## Startup ordering

`startAfter: ["api"]` spawns an app only once `api` is healthy (a worker: spawned and alive). Unlike `requiredApps`, which only adds apps to the selection, this orders them in every mode, not just around `--expose` tunnels. It selects its targets too, and a cycle is a config error. `prebuild` runs a command to completion before an app's `devCommand` starts, beside the prebuilds of its wave; the app spawns only after it succeeds.

`buncargo wait --app=<name> [--timeout=<seconds>] [--hold]` blocks until an app of this checkout's run is healthy, then exits 0; it exits 1 when the app failed or stopped, 2 at the timeout, and 130 or 143 when interrupted before the app is healthy. With `--hold` it stays alive until the app or its run stops, and a signal after the app is healthy exits 0. That is what a script or Playwright needs ("wait for the stack, then test"), and what the Shopify integration's generated web runs.

## Discovered workspaces

```typescript
apps: {
	...discoverApps({ globs: ["apps/extension-*", "extensions/*"], prebuild: "build" }),
}
```

`discoverApps` makes a worker for every workspace matching the globs that defines the `script` (default `dev`), named after its directory. A `server` kind takes a base `port`. When a workspace defines the `prebuild` script, it runs once, before the watcher starts. Two workspaces with the same name are an error, not a silent overwrite. `buncargo build --discovered` runs every discovered app's `build` in order, for CI and deploys.

Set `runner: "npm"`, `"pnpm"`, or `"yarn"` to use that package manager for the dev, prebuild, and build scripts; Bun remains the default. Script names are passed literally.

```ts
import { defineDevConfig, discoverApps, mergeConfigs } from "buncargo";

const shared = defineDevConfig({
  projectPrefix: "shared",
  services: {},
  env: () => ({ LOG_LEVEL: "info" }),
});
export default mergeConfigs(shared, {
  projectPrefix: "my-project",
  apps: discoverApps({ globs: ["apps/*"], runner: "pnpm", prebuild: "build" }),
  env: () => ({ LOG_LEVEL: "debug", PROJECT_FEATURE: "enabled" }),
});
```

`mergeConfigs` keeps added service, app, and env keys in its result type. Both shared env builders run, with override values winning. App and service entries are replaced by key, while hooks, options, tasks, and profiles merge by key.


## Captured output and generated files

```typescript
apps: {
	shopifyCli: {
		kind: "worker", devCommand: "shopify app dev",
		captures: {
			appUrl: { pattern: /Using URL:\s*(https:\/\/[^\s│|)]+)/, as: "publicUrl" },
			ready: { pattern: /Ready, watching for changes in your app/, as: "event" },
		},
	},
	api: { port: 3000, devCommand: "bun run dev", restartOn: ["captured.appUrl"] },
},
generatedFiles: [{
	path: "extensions/customer-account-prints/src/application-url.generated.ts",
	render: ({ captured, env }) =>
		`export const APPLICATION_URL = ${JSON.stringify(captured.appUrl ?? env.BASE_URL ?? "")}\n`,
	gitignore: true,
}],
```

`captures` read an app's stdout and stderr, with colour codes and box-drawing characters stripped and only complete lines matched. In the TUI every app runs under its own pseudo-terminal; a hyperlink is read as its target and a cursor jump as a line break, so URLs inside a full-screen app's links are captured too. A stream-mode attached app runs under `script` so it keeps its TTY while its output is read. A `publicUrl` capture becomes `publicUrls.<app>` and `<APP>_PUBLIC_URL`, exactly like a tunnel URL, normalized to its origin. A `value` capture becomes `captured.<name>` in hooks, `envVars`, generated files and `buncargo env --get captured.<name>`. An `event` capture only fires `onCapture`, which every kind also fires. A capture's `label` shows the value in `buncargo env`, `buncargo url` / `open`, the run registry and BuncargoBar, and its `env` sets that env var for every process, beneath the config's own `env`. So `stripe listen` needs no integration to put its webhook secret in `STRIPE_WEBHOOK_SECRET`. Mark a credential like that one `secret: true`: it stays in this run's environment, hooks and generated files, and never reaches the run registry, so BuncargoBar, a `label` and `buncargo env` in another terminal never show it. A value is reported when it appears and whenever it changes. When one changes, generated files re-render, and apps whose `restartOn` names it restart with fresh env.

A URL wider than the app's terminal is wrapped by the app itself (Ink, which Shopify CLI draws with, inserts hard newlines at the pane's width), so the scanner joins a row back onto a line that ends in a URL when the row continues it: a single token of URL characters, padding and frame aside, or the first token when the URL above cannot be complete without it. A URL counts as complete when its host is `localhost`, an IP, or a dotted name with a plausible TLD that does not stop part-way through a known tunnel domain (`https://a-b.trycloudflare` does). A `publicUrl` capture only ever takes a complete URL; a URL ending the newest line that cannot be complete waits for the next row; and a later, longer match replaces one that looked complete too early.

`generatedFiles` render before servers start (render a placeholder for what is not known yet) and again when a capture, a tunnel URL or a port changes. They are written atomically, and not at all when the content is unchanged, so watchers stay quiet. `buncargo generate` renders them once without starting anything; it uses a live run's captures, or what the environment hands it in CI (`BASE_URL=https://… bunx buncargo generate`). `setup` and `doctor` warn about a `gitignore: true` file that git does not ignore.

## Exclusive leases

`exclusive: "shopify-app:<client_id>"` marks a resource only one run on the machine may use at a time: one Shopify dev app, whose URL is rewritten by whoever ran `app dev` last; one Stripe webhook forwarder; one ngrok domain. The lease is taken before the app spawns and dropped when the run exits, or crashes. With `--takeover` (or `y` at the prompt), buncargo stops the holder's app and takes the lease. Otherwise a second run names the holder (project, worktree, branch, pid), its checkout path and since when it has held the lease, and the two ways to get it: `buncargo dev --takeover`, or ending that run (`buncargo stop --all --root <checkout>`). What it does next depends on the app: an `essential: false` app, like the Shopify CLI, is skipped and the rest of the run starts, listed as `Skipped (lease held by another run)` in the summary and repeated in the TUI's Overview, where the scrollback is out of sight; an essential app refuses the run. In a terminal it asks first, and a bare Enter means "skip" or "cancel" respectively. A run left with nothing to start fails with the same explanation. A library `start()` takes the same leases and holds them until `stop()` or until its process exits; it answers a held lease the way `dev` does without a terminal, skipping an `essential: false` app with a warning and throwing for an essential one, with the holder and `buncargo stop --all --root <checkout>` in the message. `buncargo runs` and BuncargoBar list who holds what.

## Container runtime

Services run on Docker by default. On macOS 26 or later on Apple silicon they can run on [Apple `container`](https://github.com/apple/container) instead, which boots each container in its own lightweight VM with no Docker Desktop.

```ts
export default defineDevConfig({
  projectPrefix: "myapp",
  docker: { runtime: "auto" },
  services: { postgres: { port: 5432 } },
});
```

The selection is read from `--runtime`, then `BUNCARGO_CONTAINER_RUNTIME`, then `docker.runtime`, then the `"docker"` default. `"auto"` uses Apple `container` whenever it is installed on a supported Mac, and Docker otherwise. It does not switch to Docker just because Apple's system service is stopped, which it is after every reboot: the two runtimes keep their volumes in different places, so a switch would start the project on an empty database. Buncargo starts the service instead. An explicit `"apple"` likewise fails with instructions rather than switching.

Both backends use `dev.config.ts`, the generated Compose model, inspection commands and named `.localhost` URLs. Apple's CLI has no compose support, so buncargo translates the generated service model into one `container run` per service, matching on the `buncargo.*` labels both backends write.

**Requirements.** macOS 26+ on Apple silicon, with `container system start` having been run once (the first run installs a kernel and needs a terminal, so buncargo will not do it for you). After that, buncargo starts the system service itself when a run needs it, except under CI.

**Known gaps** compared with the Docker backend:

- `restart:` policies are dropped - Apple has no equivalent. This changes nothing in practice: buncargo starts containers per `dev` run and the watchdog stops them, so no restart policy is part of the contract either backend offers.
- Compose `healthcheck:` and `depends_on:` ordering are not translated. Buncargo still runs its configured published-port probes; portless containers use process-state readiness. Use Docker when container dependencies require Compose health/completion conditions.
- Finite jobs (`kind: "job"`) require Docker. Apple selections containing a job fail before startup mutations because that backend cannot verify job exit codes.
- Any other compose key that cannot be translated is listed in a warning rather than silently ignored.
- **No DNS between containers.** Every Apple container joins one builtin `default` network (`192.168.64.0/24`), so containers can already reach each other by IP. Resolving each other by *name* needs `container system dns create`, which must run as an administrator; buncargo keeps a single deliberate `sudo` seam for the hosts daemon and does not add a second one. Note also that a container's hostname is `<project>-<service>` (for example `myapp-main-postgres`), not the compose service name. Apps on the host are unaffected - they reach services on `localhost:<port>` either way, which is how buncargo wires them already.
- Bind-mounting a host directory into an image that `chown`s it fails on virtiofs. The built-in presets all use named volumes, which are unaffected.
- Interpolation is translated for `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:?error}` and `$$`. A service using any other form (`${VAR:+x}`, a default that holds another `${...}`) fails to start on Apple, naming the value.
- New named volumes are created with a 256 GB size limit (sparse, so they take only the space used). Apple cannot grow a volume afterwards. Volumes created before this limit keep their size.
- Published ports listen on IPv4 only, so `bind` takes an IPv4 address. Clients that connect to `localhost` fall back from `::1` to `127.0.0.1` (Bun, Node and Python all do).
- A container name longer than 63 characters, the most Apple accepts, is shortened and ends in a hash of the full name.
- Memory and CPU default to Apple's 1 GiB and 4 CPUs per container. Set `mem_limit` and `cpus` on a service that needs more.

`service.postgres()` needs no special handling: Apple's named volumes are formatted filesystems, so a fresh one already contains `lost+found` and `initdb` refuses to use it as a data directory, and on this runtime the preset points `PGDATA` at a subdirectory of the mount for you. Docker's named volumes start empty and keep the mount root, so an existing project's data stays where it is.

## Startup speed

`buncargo dev --timing` (or `BUNCARGO_TIMING=1`) measures startup from CLI entry through successful app readiness. `--timing-json` emits one JSON record with `totalMs`, `phases`, and numeric `counters`. Reports also appear on startup failure; credentials and command contents are not included. Phase durations can overlap; “entry to first app spawn” is a cumulative milestone.

Warm startup skips container reconciliation only when every selected service is running with its matching `buncargo.service-hash`. Service fingerprints include effective environment values, user labels, and referenced volume definitions, and remain stable when an unrelated service joins or leaves the selection. External build/env-file inputs and unresolved Compose interpolation trigger reconciliation because equality cannot be proven.

App readiness retries start at 20 ms and back off to 200 ms. An explicit `waitForServer(url, { interval })` keeps a fixed cadence. Container commands and probes are asynchronous and cancellable, and app health checks run concurrently. An explicit `healthEndpoint` requires a successful HTTP status; `healthEndpoint: false` explicitly disables that check. Listener and container inventory are read concurrently through cancellable snapshots, once per startup phase. Registry updates and process birth identities are batched, and unchanged generated files are not rewritten.

For reproducible overhead measurements, run `bun run build` followed by `bun scripts/benchmark-startup.ts --samples=10 --parallel=1`. Use `--parallel=5` or `--parallel=20` for contention. The fixture uses real CLI/app processes and a fake runtime; it excludes image pulls, real database readiness, migrations, HTTPS, and external tunnel latency. Reports are generated locally and uploaded as CI artifacts; they are not checked into Git.

## Startup order

```
validate selected apps, dependencies, attachment, and expose targets
  → activate named hosts for dev
  → start early selected containers, wait for service readiness and job completion
  → sync envFile → beforeMigrations → migrations → optional generation → container hook → seed
  → start afterPreparation containers and wait for readiness
  → beforeServers → render generated files
  → spawn wave 1, layer by startAfter layer (prebuilds first), each layer healthy before the next
  → open requested tunnels and inject public URLs
  → spawn wave 2 → wait for wave 2 health → afterServers
```

`needsPublicUrls` splits waves only with `--expose`. **`requiredApps` does not order readiness**: it only adds apps to the selection, and they start in the same wave as the app that requires them. For ordering, use `startAfter`, which spawns an app only once the ones it names are healthy (see [startup ordering](#startup-ordering)). Healthy existing apps are reused. Both CLI and library server startup call server hooks once; `start({ startServers: false })` performs preparation without server hooks.

| Command | Work |
| --- | --- |
| `dev` | Containers, migrations, generation, seed, apps, readiness |
| `dev --up-only` | Containers and dotenv sync; no migrations, generation, seeds, or apps. The containers live as long as the checkout |
| `dev --migrate` | Early containers, dotenv sync, bootstrap and migrations; no generation, seeds, late containers, or apps |
| `dev --seed` | Selected containers and preparation, including bootstrap and forced seed; no apps |
| `dev --down` / `--reset` | Stop; reset also removes volumes. `--down` keeps services another live run of the checkout uses; `--reset` does not |

A config with services and no apps starts every service. When nothing in the
selection is an app buncargo spawns (no apps, or only `devCommand: false` ones),
`dev` holds the containers until Ctrl-C like any run, then releases them to the
idle hold; `--detach` returns once they are ready.

Ctrl-C (or `SIGTERM`, `SIGHUP`) ends a `dev` run wherever it is: the apps stop,
its named hosts and tunnels are released, the containers wait out the idle hold,
and `dev` exits 130 (143, 129). A second Ctrl-C while apps are still stopping names
them instead of exiting: an app can take its `stopGraceMs` to save data, such
as the Firebase emulators' export, and a third Ctrl-C exits without waiting for
it, which can lose that data. Once the apps are down, a second Ctrl-C exits at
once and skips the rest of the cleanup; the next `dev` in the checkout replaces
whatever was left running.

Mutually exclusive modes cannot be combined. Configuration, selection, dependency
references and cycles are validated before startup changes host configuration or
starts resources.

### App-only selections

Use `services: {}` for a project with no containers. In a mixed config, an app
without `requiredServices` can start independently of the container-backed apps:

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
  projectPrefix: "example",
  services: { postgres: service.postgres() },
  apps: {
    marketing: {
      port: 4321,
      cwd: "packages/marketing",
      devCommand: "bun run dev",
    },
    api: {
      port: 3000,
      cwd: "packages/api",
      devCommand: "bun run dev",
      requiredServices: ["postgres"],
    },
  },
});
```

`bunx buncargo dev --apps=marketing` allocates its app port, injects its environment
and supervises the process without resolving a container runtime, writing Compose,
or starting/stopping containers. Named hosts and tunnels remain available when
configured. Explicit diagnostic and shutdown commands can inspect configured
infrastructure.

A partial app-only start refuses a port conflict, or a block another checkout now
claims, that would relocate an unselected persisted service. Free the conflicting
port or start the full environment to reconcile its shared allocation.

### Portless workers

Use `kind: "worker"` for a long-running process without an HTTP listener:

```ts
apps: {
  jobs: {
    kind: "worker",
    cwd: "packages/jobs",
    devCommand: "bun run dev",
    requiredServices: ["postgres"],
    staticEnv: { QUEUE_NAME: "local" },
  },
},
```

Workers require a command and reject `port`, `expose`, `healthEndpoint` and Expo
configuration. They receive shared environment values and app overlays, but have
no generated `PORT`, `HOST`, allocated port or URL. Inherited or explicitly
configured environment values still apply. Computed port/URL types omit workers.

Worker readiness means spawned and still alive; it does not prove a connection to
a queue or database. An unexpected exit, including zero, fails supervision.
Deliberate stops remain clean. Library startup keeps supervising after returning
PIDs; cancellation and `env.stop()` clean up owned process groups.

The CLI reuses a live worker in the same checkout. `dev --takeover` explicitly
stops it and starts it in the current run. Direct library startup refuses a
duplicate worker. Ownership uses PID and process birth identity, so simultaneous
starts cannot create duplicate consumers and worktrees stay separate. Workers
appear in logs and the run registry; `buncargo stop jobs --run=<session>` stops an
owned worker. A reused worker must be stopped through its owning run.

### Portless containers and finite jobs

Omit `port` for an internal container: it has no host publication or generated URL.
Buncargo waits for the runtime to report it running. That establishes process
startup; use Docker Compose health conditions for stronger container dependencies.
Host endpoint options and host-derived environment mappings require a port.

Use a job for a finite container command. This example imports fixture data after
database preparation:

```ts
services: {
  postgres: service.postgres(),
  importData: service.job({
    afterPreparation: true,
    healthTimeout: 60_000,
    docker: {
      image: "postgres:16",
      environment: { PGPASSWORD: "postgres" },
      volumes: ["./scripts/import.sql:/setup/import.sql:ro"],
      command: ["psql", "-h", "postgres", "-U", "postgres", "-f", "/setup/import.sql"],
      depends_on: { postgres: { condition: "service_healthy" } },
    },
  }),
},
apps: {
  api: {
    port: 3000,
    devCommand: "bun run dev",
    requiredServices: ["importData"],
  },
},
```

`service.job()` sets `kind: "job"` and `rerun: "always"`, and its type refuses a
port, URL or health check, so a function that builds jobs needs no `as const`.
`requiredServices` selects the job; Compose dependencies select PostgreSQL too.
Compose references use `serviceName` when it differs from the config key.
A container depending on a job uses `condition: "service_completed_successfully"`.
Completion references must target jobs; `service_healthy` cannot target a job.

A running job is not complete. Exit zero satisfies completion; nonzero exit
prevents subsequent preparation/apps from starting and reports recent job output.
Jobs cannot publish ports, expose endpoints or set restart policies. Completion
requires Docker; Apple rejects job selections before starting resources.

`rerun: "always"` is required and is the only supported policy. First startup runs
the job; later startups rerun completed or failed jobs. Configuration changes
reconcile the container, and volume resets run initialization again. An already
running matching job is awaited. The consumer must make repeated execution safe.
Late startup does not rerun jobs already completed in the early phase.

### Selection-aware preparation

Declare service prerequisites on migrations and seeders to scope their side effects:

```ts
prisma: { service: "postgres", cwd: "packages/prisma" },
hooks: {
  beforeMigrations: async (ctx) => {
    await ctx.exec(["bun", "scripts/bootstrap-roles.ts"]);
  },
},
migrations: [{
  name: "extra-schema",
  command: "bun scripts/migrate.ts",
  requiredServices: ["postgres"],
}],
seed: {
  command: "bun scripts/seed.ts",
  requiredServices: ["postgres"],
},
```

| Preparation | Selection rule |
| --- | --- |
| Automatic Prisma migration/generation | `prisma.service`, default `postgres`, must be selected |
| Migration/seed with `requiredServices` | Every listed service must be selected |
| Migration/seed without prerequisites | Runs when at least one service is selected |
| Migration/seed with `requiredServices: []` | Also permitted in app-only runs |
| `beforeMigrations` | Selected Prisma database; without Prisma configuration, any selected service |
| `afterContainersReady` | Runs after migration/generation, before seeding, when services are selected |

A selection that skips the seed is fine for `dev`, but `dev --seed` asks for it:
there it fails before anything starts, naming the services the seed needs
(`--seed --apps=web` when `web` does not require `postgres`).

`beforeMigrations` runs after early container readiness and job completion, before
automatic Prisma migrations and ordered custom migrations. Hooks, generation
checks and seed checks receive expanded `selectedApps` and `selectedServices`.
`ctx.exec` uses the migration environment and carries cancellation; pass
`ctx.signal` to custom I/O. Bootstrap or migration failure prevents later work.
Bootstrap/migration success is not cached by configuration hash.

Set `afterPreparation: true` on a service that needs migrations or seed data before
starting. It starts after generation, `afterContainersReady` and seed, and must be
ready before apps start. Early services cannot depend on late ones, and migration,
seed or Prisma prerequisites cannot require late services. Independent containers
within a phase and apps within a wave run concurrently. `requiredApps` expands
selection only; it does not create per-app or host-to-container readiness barriers.

Containers-only mode skips all preparation hooks, migrations, generation and seed.
`dev --migrate` runs bootstrap and migrations through the same lifecycle path.
Direct `buncargo prisma <args>` is a Prisma passthrough with the database environment;
it does not run development bootstrap hooks or the complete preparation/seed lifecycle.
It starts only the database, claims it while Prisma runs (so `ls`, `stop` and the sweep
see it) and releases it into the usual idle hold when Prisma exits. Its stdout is Prisma's
alone, so `buncargo prisma migrate diff --script > migration.sql` writes only SQL; its own
lines go to stderr. `unsetEnv` does not apply to the Prisma CLI, which reads those variables
to guard destructive actions in an agent's shell. Without a terminal, `migrate reset`,
`db push --force-reset` and `db push --accept-data-loss` refuse unless `--yes` is passed
(CI and `--db=scratch_<name>` are exempt).
Every name in `prisma.urlEnvVar` is set to the checkout's database URL. Before Prisma
starts, any other inherited variable holding a Postgres URL on another host or port is
named, with its host and port but never its credentials: a `prisma.config.ts` that reads it
sends Prisma there. While one is set, a destructive command refuses, `--yes` or not; unset
the variable or add it to `prisma.urlEnvVar`.
`--db=<database>` runs Prisma against another database of the same Postgres (one
`buncargo sql --create-scratch` made), pointing every variable that names the checkout's
database at it, as `exec --db` does.
Before `migrate deploy`, `migrate dev` and `migrate status`, buncargo compares the database's
`_prisma_migrations` with the migration folders. When the database applied migrations the
checkout no longer has (a squashed or rewritten chain), it names them and exits 4 without
running Prisma: only recreating the database, `buncargo dev --reset --yes`, gets past it, and
that drops the data.
Startup failure and cancellation retain shared-container ownership rules instead
of tearing down other runs' resources.

## Output: the TUI and stream mode

A run shows its apps' output one of two ways, never both: two writers on one
screen is what garbles a full-screen app like Shopify CLI or Expo.

| Mode | When | What you see |
| --- | --- | --- |
| TUI | a terminal (the default) | A sidebar with the **Overview** and every app; the main pane shows all apps' lines interleaved, or the selected app's own terminal |
| Stream | otherwise (CI, agents, piped output, `--no-tui`) | Prefixed lines (`➜ api …`). Apps get pipes, so full-screen tools print plain lines on their own |

In the TUI every app runs under its own pseudo-terminal sized to the pane, with
an xterm.js screen and 10,000 lines of scrollback, so a full-screen app renders
natively and the others are one keypress away. The Overview gets the lines a
full-screen app scrolls past and its status events (ready, stopped, captured
URLs), not its live footer.

| Key | Action |
| --- | --- |
| `↑` `↓` / `k` `j` | Select the Overview or an app |
| `Enter` | Interact: keys go to the selected app (Shopify's `p`/`q`, Expo's menu) |
| `Esc` (or `Ctrl-]`) | Leave interact mode. An app therefore never receives a bare Esc; arrow keys and Alt combinations still reach it |
| `Esc` | Back to the Overview |
| `e` | Overview: errors and warnings only |
| `o` | Open the app's URL (the Overview offers a picker) |
| `r` | Restart the selected app |
| `l` | The app's log in `$PAGER` (the Overview: the run's log directory); `q` or `Ctrl-C` closes it and the run keeps going |
| Mouse wheel, `PgUp` `PgDn` | Scroll the Overview or the selected app's scrollback |
| `End` / `Home` | Back to the live output / the oldest line kept |
| Click in the sidebar | Select the Overview or an app |
| Drag in the pane | Select text; releasing copies it to the clipboard |
| `q` | Quit the run |

Drag in the main pane to select text: it is highlighted, and releasing the
button copies it to the clipboard (`pbcopy`, `wl-copy` or `xclip`; over SSH or
without one, OSC 52 through the terminal). The selection stays inside the
pane, so no sidebar text comes along, and a line cut off with `…` copies in
full when the selection reaches the pane's edge. A line an app wrapped to fit
the pane (Shopify CLI does) copies as one line, so a long URL comes out whole.
This is the TUI's own
selection, because the terminal cannot select while the TUI reports the mouse;
Option-drag (iTerm, Terminal) or Shift-drag (most others) still selects
natively.

Keys an app declares in `actions` show in the footer once their capture has a
value. Anything else that prints during the run (hooks, warnings) lands in the
Overview as a `buncargo` line. The terminal is restored on every exit path,
including a crash.

`o`, `buncargo open <app>` and BuncargoBar's Open use one rule, recorded per app
in the run registry as `openUrl`: a public tunnel URL when the app is exposed,
else the named `https://` host while the hosts daemon serves it, else loopback.

Both modes write each app's output, plain, to `.buncargo/logs/<run>/<app>.log`
(the last ten runs, and any older run still going; 5 MB per file), and a seed that runs beside the apps
(`seed.beforeApps: false`) to `seed.log`. `buncargo logs [app] [-f] [--since=5m]
[--errors] [--run=<sessionId>]` reads the live run that runs `app`, else the last run with a log
for it; without an app, the last run. `--run` picks a run by the session id `buncargo runs` prints,
and `-f` ends once that run has ended. `--errors` keeps the lines that read as errors: a level
the logger wrote (`INFO:`, `[WARN]`, `level=info`) wins over words like "failed", and a structured
block an error line opens (`[ERROR] job.completed {` … `}`) is kept whole.

### Non-essential apps

`essential: false` keeps the run going when that app exits. It shows as stopped
(or failed) with its exit code, its pane keeps its last output, and `r` in the
TUI or `buncargo restart <app>` starts it again without re-running anything
else. It never holds startup up: it is health-checked on the side, and one that
never answers is stopped and shown as failed. In stream mode the run prints the
app's last error lines and the restart command.

### When an app does not come up

In `buncargo dev`, an app that does not become ready, crashes while it starts,
or cannot be started again by a restart is stopped and shown as failed, and the
other apps keep running; `buncargo restart <app>` tries it again, and once it is
up its exit ends the run like any app's. The run still fails when nothing else
is left, or when another app `startAfter`s the failed one.
`options.onAppFailure: "stop-run"` ends the run instead, which is what `ci` and a
library `start()` always do.

A worker, or an app with `healthEndpoint: false`, has started once it is spawned
and the rest of its wave is up, so its crash after that ends the run. Give it a
`readyWhen` line, and a crash before that line counts as crashing while it starts.

### Watching files

`watch: { paths: ["src"], ignore: ["dist/**"] }` restarts the app with a fresh
process when a file under `paths` (relative to the app's `cwd`) changes: the
supervisor sends SIGTERM, waits for the exit and spawns it again. Use it instead
of `bun --watch`, which on macOS keeps about 3,000 file descriptors per reload
until the machine's file table fills. `node_modules`, `.git` and `.buncargo`
are always ignored; changes within `debounceMs` (150) restart once. Watching
starts once the run is up. `dev --no-watch` turns it off for one run.

A restarted app, by `watch`, `restartOn` or by hand, has to become ready again
within its `healthTimeout`, like it did at start. If it does not, `buncargo dev`
stops it and shows it failed, while `ci`, a library `start()` and
`options.onAppFailure: "stop-run"` end the run. Raise `healthTimeout` for an app
whose restart takes longer.

### Ready by output

`readyWhen: /Logs for your project/` makes an app ready when its output
matches, instead of when its `healthEndpoint` answers: for Expo, or a worker
that is only useful once it prints "connected". Each process is matched on its
own, so a restart waits for the line again, and `healthTimeout` bounds the wait.

An app that starts listening on a different port than its own while that port
is held by something else (Astro and Vite without `strictPort` move to the next
port) fails within a second or two, naming both ports and the holder, instead
of waiting out its health timeout.

### Preflight

`preflight: [{ name, apps?, run({ root, env, interactive }) }]` runs before the
TUI takes the screen, with the real terminal, so a step can prompt or open a
browser. `apps` limits a step to runs that select one of them, and must name
configured apps. A step that
throws stops the start with its message. Integrations contribute steps too:
`shopify()` renews an expired Shopify CLI session here instead of failing
inside the run.

Preflight runs before the containers start. Housekeeping that needs the
database, such as unlocking jobs a killed worker left locked, belongs in
`hooks.afterContainersReady`: it runs on every start, once the services are
healthy and migrations have run, before any app starts.

### Attached apps (stream mode)

Without the TUI, one app may set `interactive: true` (`--attach=<app>`
overrides it) and keep the real terminal; the others are prefixed lines with
stdin ignored. When the attached app exits, the run ends. Args after `--` are
appended only to the attached command. The TUI ignores `interactive`: every app
has a terminal of its own.

When `dev` itself has no terminal (an agent's shell, `--detach`), the
interactive app gets a pseudo-terminal of its own instead, so Expo starts its
dev server rather than refusing, and its output is logged like any app's.
`buncargo send <app> <keys>` types into it (`buncargo send expoApp r` reloads
it; `--enter` presses Enter after the text). `send` reaches every app in the
TUI the same way. It waits for the run to answer: exit `0` typed,
`2` no run started that app, `3` the app cannot take keys (no terminal of its
own, or not running; it says which), `1` when the run does not answer within
five seconds.

## Expo and the iOS simulator

Expo Go and a development build are shells: the JavaScript comes from whichever Metro a deep link names. So two worktrees of an Expo app are two Metro ports plus two simulator devices, one per checkout, each opened on its own port. One device cannot hold two installs of the same bundle ID, but two devices can run side by side.

```bash
bunx buncargo dev --apps=expoApp   # Expo attached, Metro on this worktree's port
bunx buncargo expo sim             # in another terminal, or the phone button in BuncargoBar
```

`buncargo expo sim` reads the run registry, so it needs no config and no Docker. It

1. finds or creates this checkout's device, named `<projectPrefix>/<worktree> · iPhone 16 Pro`, by cloning the simulator you last used in Simulator.app (or the app's `simulator` in `expo({ apps })`), so the development build installed there comes along;
2. boots it and brings Simulator.app to the front;
3. waits for Metro to listen on the app's port;
4. opens the development build when it is installed on that device, else Expo Go, on `127.0.0.1:<port>`.

If neither is installed on the device it says so: press `shift+i` in the Expo terminal and pick the device, or run `npx expo run:ios --device "<name>"` once. Expo CLI's plain `i` opens on the first booted device, which with two worktrees up is not always yours.

```typescript
import { expo } from "buncargo/expo";

integrations: [
	expo({
		// Default: every app whose devCommand runs `expo`.
		apps: {
			expoApp: {
				scheme: "myapp",            // default: `scheme` in app.json, else exp+<slug>
				simulator: "iPhone 17 Pro", // default: the device Simulator.app last showed
			},
		},
	}),
],
```

Without `integrations: [expo()]` an app is not treated as Expo, even when its `devCommand` runs `expo`.

The deep-link scheme and `ios.bundleIdentifier` are read from `app.json` when the run is published. A project configured only through `app.config.ts` sets the app's `scheme` in `expo({ apps })`. Named HTTPS hosts are not trusted inside the simulator, so point `EXPO_PUBLIC_*` URLs at the LAN IP or `loopbackUrls`.

## Ports and isolation

Non-worktree projects now get a stable nonzero offset from `projectPrefix`. Worktrees add the worktree name when `options.worktreeIsolation` is true (default).

```
BUNCARGO_PORT_OFFSET set?
  yes → use it, skip probing (provenance: env)
  no  → this checkout's (or environment's) claim in ~/.buncargo/offsets.json?
          yes → its offset, applied to the config's current ports, if they
                are free or ours and no other checkout claims the block
                (provenance: claim)
          no / not usable → hash projectPrefix [+ worktree] [+ suffix]
                          skip blocks another checkout or environment claims
                          (its offset, or any one of its ports)
                          probe every service and app port
                          on a foreign owner, or a port that will not bind,
                          shift the whole block by 100, up to the highest
                          offset that keeps every port below 32768 (never
                          below 9000), then from 100 until every block was tried
                          every block taken? reclaim the least recently used
                          block of checkouts with no run and no containers, and
                          try again (dev and start(); a read answers
                          provenance: unallocated instead)
          claim the offset and its ports in ~/.buncargo/offsets.json
```

Offsets are claimed machine-wide, by checkout, in `~/.buncargo/offsets.json`,
together with the ports of the block, so two projects whose ports differ never
end up sharing one through different offsets. A checkout keeps its offset
whether or not it is running, and the claim goes when its directory does. Without claims, two worktrees whose names hash to the
same offset only collided while both ran, so which got which ports depended on
which started first. `buncargo ports` lists the claims, and it and `doctor` report
two claims whose blocks overlap, naming both checkouts and the ports they share.

A claiming run that finds `offsets.json` unreadable, or written by a newer buncargo,
stops with an error naming the file and leaves it as it is: rewriting it would drop
every other checkout's claim. Update buncargo, or move the file aside to let every
checkout be assigned its ports again.

A suffixed environment (`withSuffix()`, `buncargo ci`, an E2E stack) claims its
own offset next to its checkout's dev claim, and gives it back when it is stopped.
In CI the dev claim goes the same way: `dev --down` or `stop()` frees the block, so
runners whose directories persist between jobs do not hold blocks they no longer use.
A developer's dev checkout keeps its claim while it is stopped.

A claim also records the checkout's Compose project name, and `dev`, `ci` and
`start()` refuse to run under a name another existing checkout uses: the two
would share containers and volumes. Self-hosted CI runners on one machine check their repository
out into directories with the same name. `buncargo ci` adds the runner's name to its
own project, so for `dev` and `start()` give each runner its own prefix:

```ts
const runner = process.env.RUNNER_NAME?.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export default defineDevConfig({
	projectPrefix: runner ? `myapp-${runner}` : "myapp",
	// ...
});
```

A `dev.config.ts` below the top of a Git worktree (in a subdirectory, not at the
repository root) does not get the worktree's name in its project name, so every
worktree shares the main clone's. Derive its prefix from the worktree:
`getWorktreeProjectSuffix(<repository root>)` returns the worktree's name, or
`null` in the main clone. `example/playground/dev.config.ts` does this.

When every block is claimed, `dev` and `start()` reclaim the block of the
checkout started least recently that has no run and no containers (running or
in the idle hold) and was not started in the last hour, say whose, and
allocate again. That checkout keeps its containers, volumes and project name,
and gets a new block on its next start. When nothing can
be reclaimed, the error lists every checkout in the way with its state and when
it last started, and the commands that free one. A checkout that has never run
reads as `unallocated` in that state (`status`, `env`, `ports`): its ports are
another checkout's until `dev` or `ports pin` gives it a block, and `exec`
refuses to run on them.

`buncargo ports release --idle=7d` (a bare number is days; `12h` and `30m`
work too) frees the blocks of every checkout not started for longer than that,
with no run and no containers, the way a full range does. It lists them and
asks first, like `--root`, and touches no container or volume; each checkout
keeps its project name. A deleted checkout's claim is left to the sweep, which
uses it to find that checkout's volumes.

A claim otherwise stays until its checkout runs again or is deleted, so a checkout that
last ran an older config keeps that config's project name, and the refusal
names it. When it no longer uses that name, release its claims:
`buncargo ports release --root <path>`. It lists the claims and asks first
(`--yes` from a script or agent), refuses while that checkout is running or its
containers are still up (`buncargo stop --all --root <path>`), and touches no
container or volume. A claim a run used after the listing is kept, and the
command then exits `3`. The checkout claims again on its next run. Whoever runs
under the released name next uses the volumes left under it.

`buncargo ports pin <offset>` moves a checkout to a block and keeps it there:
it checks every port of the block (binding it, so hidden holders count) and
the claims, then writes the claim. Like `dev`, it refuses while another
checkout claims its Compose project name. Its containers move on the
next start, since their ports are part of what decides reuse. The claim is the
only record of a checkout's block; there is no file in the checkout to edit.
When a run cannot use its claimed block (an offset someone else claims, a port
taken), it says why before moving.

Every container the daemon runs counts, not only the checkouts in this user's
`~/.buncargo`: a CI runner's user and a developer's sharing one Docker each keep
their own claims, so a port another user's stack publishes moves the block too.
A checkout's own containers (its Compose project, on the runtime it uses) never move it.

A port nothing visible holds but that cannot be bound (a root process `lsof` hides from this user, often a macOS service such as Screen Sharing on `:5900`) counts as foreign; `doctor` reports it as held by an unidentified process.

Offsets use a step of 100 so `5432` becomes `5532` / `5632` instead of overlapping nearby defaults. A checkout's first offset is hashed into 100–9000; when that block is taken, the search goes as high as the config's highest port allows while staying below 32768, where Linux starts handing ports to outgoing connections.

`worktreeIsolation: false` shares the compose project name **and** the offset across worktrees.

`checkoutProjectNames()` returns the Compose project names a checkout's stacks run under, for tools that find or clean up its containers and volumes without loading the config. `ci` is the one stack older `buncargo ci` runs shared; each run now has its own (see [CI](#ci)):

```ts
import { checkoutProjectNames } from "buncargo/api";

checkoutProjectNames({ projectPrefix: "gey", root: "/code/t3code-fc4fa622" });
// { dev: "gey-t3code-fc4fa622", ci: "gey-t3code-fc4fa622-ci" }

// A deleted worktree: name it, since its `.git` file is gone.
checkoutProjectNames({ projectPrefix: "gey", root: "/code/renamed", worktree: "feature" });
// { dev: "gey-renamed-feature", ci: "gey-renamed-ci-feature" }
```

`root` defaults to the monorepo root above the working directory, and `worktree` to the name in the root's `.git` file (`null` is the main checkout). Pass the config's `worktreeIsolation` when it is `false`.

Ports still exist: processes listen on the allocated numbers, Docker publishes them, and tools like TablePlus keep using `localhost:<port>`. Named hosts are an overlay so humans and `*_URL` env vars stop typing those ports.

## Named local URLs

Opt-in HTTPS names on loopback. Buncargo still allocates ports and starts processes; a shared daemon on `:443` gives those ports hostnames.

| Checkout | App `web` | App `api` | Service `mailpit` |
| --- | --- | --- | --- |
| Main | `https://web.myapp.localhost` | `https://api.myapp.localhost` | `https://mailpit.myapp.localhost` |
| Worktree `fix-ui` | `https://fix-ui.web.myapp.localhost` | `https://fix-ui.api.myapp.localhost` | `https://fix-ui.mailpit.myapp.localhost` |

`options.primaryApp: "web"` collapses that app to `https://myapp.localhost` (or `https://fix-ui.myapp.localhost` in a worktree). The worktree label is the **directory name**, not the git branch.

Enable with `options.hosts: true` (or `{ tld?, services? }`). Postgres, Redis, and other TCP services stay as connection strings on `localhost:<port>`. Default named HTTP services are Mailpit and Typesense. A service gets a name only when it serves pages: an HTTP preset (Mailpit, Typesense, MinIO), or a custom container with `exposeProtocol: "http"`. One whose URL carries credentials or comes from `urlTemplate` keeps it.

The first `buncargo dev` in a repo with `hosts` on prompts for one-time machine setup (trust a local CA, bind `:443`). Enter accepts, `s` skips once, `n` persists a decline, which `doctor --fix` leaves alone and `buncargo hosts install` undoes. `buncargo hosts install` is the non-interactive path, and trusts the CA again even when its files are already there. Setup is per machine: later repos and worktrees reuse it.

Both steps need your password: the CA goes into the system trust store, and only root may bind `:443` or write the launchd/systemd unit. Setup is all-or-nothing - if the service fails to load, buncargo puts back the service that was there before (or removes the one it added) rather than leave a half-installed machine that skips setup on the next run. Setup is skipped without a TTY, since the password prompt would hang.

Certificates cover wildcards, not just the exact hostnames: a project serving `api.myapp.localhost` also gets `*.api.myapp.localhost` and `*.myapp.localhost`, so the *next* worktree of that project needs no new certificate. That matters because minting one makes the daemon rebind, which drops every proxied websocket on the machine - including HMR sockets belonging to projects that had nothing to do with the new worktree. The names each checkout wants are remembered in `~/.buncargo/cert-names.json` so a project stopping does not drop its coverage; an entry is retired once its checkout is gone from disk.

A run asks the daemon to reload before it checks that its hostnames are served, rather than waiting for its next poll, and the daemon hands over between listeners without closing the port, so starting a run in a fresh worktree does not race it.

`buncargo hosts install` records what it installed in `~/.buncargo/hosts-service.json`: the buncargo version, and the protocol its daemon speaks. One daemon serves every project on the machine, whichever buncargo each one pins. A project needs a daemon of at least its own protocol, and a newer one serves it too, so projects on different releases share it without asking to reinstall. `buncargo hosts install` never replaces a newer daemon with an older one; `--force` does. The daemon also runs whichever Bun started the install, so a Bun that moved or was removed leaves the service pointing at a path that no longer exists. When the daemon is too old or broken, `buncargo dev` prompts to update it (Enter updates, `s` skips this run) rather than waiting for you to notice; without a TTY it warns and continues on `localhost:port`. `buncargo hosts status` and `buncargo doctor` report the same thing, and `buncargo hosts install` or `doctor --fix` repairs it outright.

The daemon logs to `/var/log/buncargo-hosts.log` (on Linux, also `journalctl -u buncargo-hosts.service`). A failure that persists is logged at most once a minute, with a count of what was suppressed, so a stale daemon retrying a certificate it cannot serve cannot fill the disk.

`buncargo hosts daemon` runs that same proxy in the foreground instead of under launchd/systemd, which is how you watch its output while debugging. It re-reads `~/.buncargo/routes.json` every second, so apps starting and stopping need no restart, and it exits on its own once no routes have been registered for a while. `--service` is what the installed unit passes: it keeps the daemon alive through idle periods and is not meant to be typed by hand. It binds `:443` and `:80`, which needs root, so run it under `sudo` with the service stopped.

Failure degrades to `http://localhost:<port>` and never blocks the dev run. `buncargo env`, `status`, `open` and `getEnvVar` report a named URL only while a run of the checkout serves it, and `http://localhost:<port>` otherwise, so a `vite.config.ts` gets the URL the run is actually on. Named hosts stay off on Windows, in CI (`CI=1` / `CI=true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`), when `BUNCARGO_HOSTS=0`, or with `--no-hosts`.

Set `BUNCARGO_HOSTS=0` in cloud workspace secrets/environment to skip automatic local HTTPS setup, including the mkcert prompt. Local URLs use `http://localhost:<port>`; Remote sharing still works.

### Named URLs over Tailscale

On a remote dev machine, `*.localhost` names are no use: they resolve to whoever is looking. Set `BUNCARGO_HOSTS=tailscale` on that machine and, in a config with `hosts` on, each app gets a real HTTPS URL on the machine's Tailscale name, reachable from every device on the tailnet:

| Checkout | App `web` (port 5199) | App `api` (port 3010) |
| --- | --- | --- |
| Main | `https://worker.tailnet.ts.net:25199` | `https://worker.tailnet.ts.net:23010` |
| Worktree at offset 100 | `https://worker.tailnet.ts.net:25299` | `https://worker.tailnet.ts.net:23110` |

Each app is served on its own port plus 20000, through [Tailscale Serve](https://tailscale.com/kb/1312/serve) with the certificate Tailscale issues for the machine: no CA to install, no root. The HTTPS port is claimed with the checkout's port block, so two worktrees never get the same one. `<APP>_URL`, `urls.<app>`, the banner, `open` and the menu bar use the HTTPS URL; `loopbackUrls`, `<APP>_LOOPBACK_URL` and `<app>Local` stay as they are, and services are not served.

It needs Tailscale up and logged in, HTTPS Certificates and MagicDNS turned on for the tailnet (admin console, DNS), and on Linux permission for your user to change Serve: `sudo tailscale set --operator=$USER`, once. An app is only given its HTTPS URL once Tailscale answers on it; anything missing degrades to a warning and the plain URL, and never stops the run. `buncargo doctor` checks each requirement.

Buncargo records every Serve entry it adds in `~/.buncargo/tailscale-serve.json` and removes them when the run ends; the watchdog, `ls`, `doctor` and `buncargo hosts prune` remove those of a run that ended without cleaning up. It never touches a Serve entry it did not add. `buncargo hosts status` lists them.

### Loopback URLs

Some clients cannot follow a named HTTPS URL: Playwright does not trust the local CA, the Stripe CLI fails the HTTP→HTTPS redirect, and GUI database clients want a plain connection string. Enabling `hosts` rewrites `urls.<name>` in place, so those consumers get `loopbackUrls` instead - the same set of services and apps, always addressed as `http://localhost:<port>`.

It is available everywhere the URLs are: `env.loopbackUrls`, the `env()` and `envVars()` context, `HookContext`, the `<NAME>_LOOPBACK_URL` env var, and `buncargo env --get loopbackUrls.api` for shell scripts. There is no `<app>Local` member - that key is the LAN IP, a different address for a different purpose (mobile devices on the network).

```typescript
// playwright.config.ts
const env = JSON.parse(execSync("bunx buncargo env").toString());
export default defineConfig({ use: { baseURL: env.loopbackUrls.web } });
```

## Remote services

Copy a connection token from BuncargoBar's key menu, or run `bunx buncargo connect token` on your computer. Store it in your cloud environment as `BUNCARGO_CONNECT_TOKENS`; multiple recipients use comma-separated tokens. Set `BUNCARGO_CONNECT_NAME` to group runs under a name such as `Cursor cloud`, then run `bunx buncargo dev` normally.

Every selected app and service with a host port is shared automatically. Workers, jobs and portless targets are skipped. There is no sharing flag or `expose` filter. Without recipient tokens, development stays local. The CLI downloads a pinned, verified frpc automatically on Linux and macOS; no administrator access or interactive sign-in is needed.

Browser apps open public HTTPS URLs directly through our relay. Tokens authorize directory discovery and private TCP connections, not browser access: anyone with an app URL can reach its existing app authentication. Postgres, Redis and other TCP services use private loopback visitors created on demand; TablePlus receives the actual local port and dev credentials. Rows reuse the same components as local runs and show name, project, branch and worktree.

```sh
bunx buncargo connect status
bunx buncargo connect status --json
bunx buncargo connect tcp <target-id>
```

Use same-origin frontend API paths through your dev server's proxy where possible. Absolute sandbox-local URLs in JavaScript are still local to the browser's computer. HTTP, SSE and WebSockets stream through frp; Buncargo does not rewrite application authentication or frontend bundles. The separate `dev --expose` Cloudflare quick-tunnel feature is independent of remote sharing.

See [connection setup, lifecycle, and relay operation](../docs/frp.md).

**Cookies ignore ports:** apps sharing the machine hostname must namespace their development cookies. Buncargo supplies `BUNCARGO_WORKSPACE_ID` and, for Expo apps, `EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID`. Use the cookie helper in your auth configuration; install Buncargo as a runtime dependency in apps that import it. The backend helper preserves production and E2E cookie names, while the client helper uses Expo’s `__DEV__` flag. Missing workspace IDs retain the original names. This prevents accidental session collisions between trusted dev apps, not cross-app security isolation.

Backend:

```ts
import { devCookiePrefix } from "buncargo/runtime";

const advanced = {
	cookiePrefix: devCookiePrefix("platform"),
};
```

Expo:

```ts
import { devCookiePrefix } from "buncargo/client";

const workspaceId = process.env.EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID;
const options = {
	cookiePrefix: devCookiePrefix("platform", workspaceId),
};
```

Expo requires the literal public environment-variable read in application code: Metro does not inline those reads inside dependencies. Other browser clients pass their development flag explicitly as the third argument; the client helper otherwise leaves the prefix unchanged when `__DEV__` is unavailable. The client entry has no Node or Bun imports.

Update both the CLI and menu bar to use connection discovery.

## Run registry and the menu bar app

Every `buncargo dev` publishes itself to `~/.buncargo/runs.json`: project,
worktree, branch, pid, and each app and service with its URL, public tunnel and
state. It is written when the run starts, patched as servers become ready, and
removed on teardown. Readers filter dead owners without rewriting files; writers prune obsolete entries. Each new invocation has a session identity, so different app subsets in one checkout remain visible.

```bash
bunx buncargo runs          # grouped by project, main checkout first
bunx buncargo runs --json   # the same data, for scripts and agents
```

Unlike `ls`, this needs no container runtime, so it answers instantly and works
with Docker stopped.

### Stopping one thing

```bash
bunx buncargo stop api        # SIGTERM that dev server's process group
bunx buncargo stop postgres   # docker/container stop for that service
bunx buncargo stop --all      # checkout sessions and their idle containers; retains containers another live session needs
bunx buncargo stop            # the same as --all (`buncargo down` runs it too, with a hint)
bunx buncargo stop api --run=<session-id>  # select an exact run
```

Stopping one app does not end the run: a signalled exit is not a failure to the
child supervisor, so the other apps and the containers keep going. Two targets
are refused without `--force` (and prompt when there is a terminal): the
attached app, because closing it tears the run down by design, and an app this
run reused from another terminal, because that process is not ours. A process
whose identity cannot be read (`ps` failed or timed out) is refused too, rather
than reported stopped while it may still run. Exit codes are `0` stopped (or
nothing running for this checkout), `1` it could not be stopped (a teardown
failed, the runtime did not answer, a port could not be freed) or a usage error
such as an unknown flag, `2` no such app or service, `3` refused: left running
on purpose. A run that ends on its
own just as `stop` reaches it counts as stopped, and its idle containers are
taken down. Stopping a run also removes its checkout's service routes from the
named hosts. A stopped Docker daemon or Apple system
service has nothing to stop, but one that refuses this user or does not answer
may still run the containers, so `stop` and `dev --down` exit `1` rather than
reporting nothing to stop.

`buncargo restart <app>` asks the `buncargo dev` run that started the app to
replace it, and returns once that run answers, so
`buncargo restart api && buncargo wait --app=api` waits for the new process.
Exit codes are `0` the app's process was replaced, `1` the replacement failed
(the error says why) or the run did not answer in time, `2` no run of the
checkout started the app, and `3` refused, with nothing restarted: a script's
`start()` takes no restart requests (restart the app from that script instead),
or the app runs in another terminal and was reused.

An app gets its `stopGraceMs` (5 seconds unless set) to exit after SIGTERM
before it is killed. Stopping a whole run waits 5 seconds plus the longest
grace among its apps, because the run stops its apps itself.

Every stop and removal buncargo makes (`stop`, `dev --down`, `--all`, the
watchdog, the menu bar's buttons) is recorded with the command, its pid, what
ran it and why. `buncargo status` lists this checkout's latest ones, and
`doctor` the last three.

A running `dev` (and a library `start()`) watches its own service containers.
When one stops, is removed, keeps restarting, is paused or fails its healthcheck, the run prints
`postgres stopped (exit 0)` with whoever stopped it, writes it to the run's
`buncargo.log`, and `status` shows the run as degraded. It does not restart the
service: the cause is unknown when it fires, and a restart would hide it.

Services are stopped, never killed, so a `restart:` policy cannot undo it.
Nothing in buncargo brings a stopped container back, so it stays down until the
next `dev`; once the run itself ends, the watchdog removes it. Stopping a whole
run removes its containers. `stop --all` also removes the containers a finished
run of this checkout left waiting out its idle hold (after Ctrl-C, say) and
forgets that run; no confirmation, since nothing of it is still running.

### BuncargoBar

A macOS menu bar app over the same registry, for when the run you want is in a
terminal window you closed three worktrees ago.

Projects are headers and each checkout is a row - `Main`, or the worktree name
with its branch beneath - so several worktrees of one project stack up under it.
Only running checkouts appear. **Open** launches the primary app and the phone
button opens an Expo app in that checkout's simulator; the chevron opens a panel
with every app and service, each with open, copy, a TablePlus button for
databases, a simulator button for Expo apps, and a stop button. **Stop run**
stops everything.

It is a reader: it never signals a process, talks to Docker or drives `simctl`;
it shells out to `buncargo stop` and `buncargo expo sim` using the exact interpreter
that started the run, so a worktree on a different buncargo version acts with
its own build. See [`menubar/README.md`](../menubar/README.md).

```bash
bunx buncargo bar install
```

`buncargo dev` offers it once, the first time it runs on a Mac without it:
Enter installs, `s` skips this run, `n` never asks again. The offer is silent on
Linux and Windows, in CI, without a TTY, under `BUNCARGO_BAR=0`, and whenever
the named-hosts setup already asked something this run - one setup question per
run, at most.

## Dotenv sync

buncargo injects the right environment into processes it spawns, but `bun test`, an ad-hoc `bun run` and Playwright read `.env` off disk. Because the port offset is a hash of the project name and shifts again per worktree, a hand-written `localhost:5432` is stale by construction.

```typescript
options: {
  envFile: true,                              // .env
  // envFile: { path: ".env", createFrom: ".env.example" }
}
```

It runs once containers are ready and before migrations, since Prisma reads `.env` itself. The rules are deliberately conservative, so the file stays the repo's contract rather than buncargo's dump:

- Only keys **already in the file** are touched; an absent key is never added, and a missing file is only created when you set `createFrom`.
- A value is only replaced when it is empty, a bare port number, or already on `localhost` / `127.0.0.1`. A deliberate override - a cloned remote database, a shared staging service - survives untouched.
- Comments, ordering, quoting, `export` prefixes and spacing are preserved byte for byte.
- Values come from the **loopback** URLs, never the named `https://` hosts.
- Keys buncargo cannot derive - a second connection string for the same database, a URL with a path suffix - come from `values`, which is handed the ports and the loopback URLs and nothing else:

```typescript
envFile: {
  path: ".env",
  createFrom: ".env.example",
  values: (ports, loopbackUrls) => ({
    DATABASE_URL_PGBOUNCER: loopbackUrls.postgres,
    API_URL: `${loopbackUrls.api}/api`,
  }),
}
```
- The write lands through a temp file and a rename, so a test runner loading `.env` concurrently never sees it truncated.

A server that exits zero after detaching its listener is adopted by pid and process identity. Buncargo warns with the app, port and command, and stops the detached server with the run. Its framework may write logs to its own files after detaching.

The `dev` banner lists the selected apps (including reused apps) and their required services. `url` and `env` continue to list the full configuration.

## Checkout files

Secrets that live in gitignored dotenvs (`.env.local`, `apps/expo-app/.env`) are missing from every
new worktree and every fresh clone. List them in `checkoutFiles` and buncargo puts them there:

```ts
options: {
  envFiles: [".env.local"],                          // what buncargo reads
  checkoutFiles: [
    { path: ".env.local", template: ".env.example" }, // template when nobody has it yet
    "apps/expo-app/.env",                            // a file buncargo itself does not read
    { path: ".env.machine", machine: true },         // never leaves this machine
  ],
},
```

Buncargo keeps one copy of each per machine, the file store (`~/.buncargo/files/`), and before
any command reads `envFiles` it brings the checkout's copy up to date:

- A checkout without the file gets the store's copy. When the store has none either, buncargo
  copies `template` for you to fill in. It is stored once you have filled it in; until then, a
  copy that arrives in the store replaces it.
- A checkout that has a file the store lacks puts it in the store, so other checkouts get it.
  Existing setups need no migration.
- When the store's copy changes, every checkout whose copy is untouched gets the new one, with
  one line naming the file.
- A copy you changed is never overwritten. `buncargo dev` reports it; `buncargo files save`
  shares your change with the other checkouts, and `buncargo files pull --force` takes the
  store's copy instead (yours is kept in `.buncargo/files-backup/`).
- When you changed a dotenv and the store changed too (`conflict`), start with
  `buncargo files merge <path>`: it keeps both sides' changes, key by key, and saves the result to
  the store; `files save` and `files pull --force` keep one side instead. For a file that is not
  dotenv, buncargo suggests only those two. A key changed on both sides is
  named (never its value) for you to choose: it asks in a terminal, or takes
  `--checkout=KEY,...` (keep yours) and `--store=KEY,...` (take the store's). Comments, order and
  quoting stay as in your copy.

Files must be gitignored, under 1 MiB and inside the checkout; buncargo refuses symlinks and
tracked files, and `buncargo setup` adds a missing ignore rule. Nothing prints values: `files diff`
lists the keys that differ. In CI, files are only copied when a store exists.

`buncargo files status [--json]` shows each file's state (`in-sync`, `store-newer`, `local-edits`,
`conflict`, `missing`). `pull` exits 1 when a file is left different from the store. To set up
another machine, `buncargo files export` writes the store as a bundle to stdout (without
`machine` files unless `--include-machine`) and `buncargo files import [file]` reads one from a
file or stdin, then pulls:

```bash
bunx buncargo files export | ssh box 'cd app && bunx buncargo files import'
```

## Environment variables

### Dotenv input

Use `options.envFiles` to load root-relative dotenv defaults for dev, Prisma, exec
and programmatic environments:

```ts
options: {
  envFiles: [".env.defaults", { path: ".env.local", optional: true }],
},
env: (_ports, urls, ctx) => ({
  JOBS_DATABASE_URL: urls.postgres,
  TOKEN: ctx.env?.TOKEN,
}),
```

Paths resolve from the discovered repository root, even when invoked in a nested
workspace. String entries are required files. `optional: true` permits a missing
file but does not hide read/permission errors. Later files override earlier ones.
Dotenv quoting and multiline values are supported; shell expressions and
`${OTHER_VARIABLE}` references are not expanded.

Environment precedence, lowest to highest:

1. Explicit dotenv files, in order.
2. This checkout's `buncargo env set` overrides.
3. The inherited process environment, for the keys 1 and 2 declare.
4. Generated local values and service static values, then shared `config.env`.
5. App static values, generated server `PORT`/`HOST`, then app `envVars`.
6. `buncargo env set` overrides again, unless the shell set that variable.
7. Explicit programmatic exec `options.env`, if supplied.

`buncargo env set KEY=VALUE` keeps an override in `.buncargo/env.json`, for a
value a shared file gets wrong in one checkout. It applies to every run, `exec`,
task and `env --export` of the checkout, wins over buncargo's own values and an
app's `envVars`, and is shown by `status`. One that hides an Infisical secret
says so when the secret is loaded. `buncargo env unset KEY` drops it.

`dev`, `status` and `doctor` warn about a loopback URL (`http://localhost:8079`)
in a dotenv checkout file or the injected environment whose port is not one of
this checkout's and has nothing listening, and name the port it probably
meant. `buncargo files save` warns when a saved file shares such a URL.

A stale dotenv `DATABASE_URL` cannot override the allocated local URL. Deliberate
configuration and app overrides remain authoritative. Use the shared callback for
project-specific aliases and `ctx.env` for resolved inputs.

The computed environment (`buncargo env`, `env --export`, `buildEnvVars()`, the
build fingerprint) carries only the keys the files and overrides declare. The
rest of the shell, such as an exported token or `PWD`, is not printed; `ctx.env`
in a callback still sees all of it, and child processes still inherit it.

Inputs load **after config evaluation**. Top-level config imports cannot depend on
files declared by that config. Each environment holds an input snapshot; create or
load a new environment to reread the files. Loading does not mutate `process.env`,
leak inputs between projects or rewrite credentials. `options.envFile` is the
independent, opt-in [output synchronization](#dotenv-sync) setting. Without
`envFiles`, child processes still inherit their parent environment.

Use `loopbackUrls` for host-side scripts, LAN/device URLs for device access, and
`ctx.publicUrls` for explicitly enabled tunnels. Docker containers use Compose
service DNS names and container ports to communicate. Host gateway names such as
`host.docker.internal` are not guaranteed across runtimes. Keep internal database
credentials out of browser and Expo public environment mappings.

### Injected

| Variable | Where | Meaning |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | Compose / shared env | Isolated project name |
| `NODE_ENV` | Shared env | `development` unless production build |
| `<NAME>_PORT` | Shared env | Assigned port for each port-bearing service/app. `<NAME>` is the key upper-cased with `-` as `_`: `my-db` is `MY_DB_PORT` |
| `<NAME>_URL` | Shared env | Local URL. Named HTTPS when hosts are active (`https://api.myapp.localhost`, or `https://<machine>.ts.net:<port>` with `BUNCARGO_HOSTS=tailscale`) |
| `<NAME>_LOOPBACK_URL` | Shared env | Always `http://localhost:<port>`, never rewritten by named hosts |
| `<NAME>_PUBLIC_URL` | Shared env | Tunnel URL while a tunnel is active |
| `NODE_EXTRA_CA_CERTS` | Shared env | Path to the mkcert CA when named hosts are active |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Shared env | `.localhost` (or `.<tld>`), or the Tailscale name, so Vite accepts the named Host |
| `DATABASE_URL` | Shared env | From `service.postgres()` |
| `REDIS_URL` | Shared env | From `service.redis()` |
| `CLICKHOUSE_URL` | Shared env | From `service.clickhouse()` |
| `CLICKHOUSE_NATIVE_PORT` | Shared env | ClickHouse `secondaryPort` |
| `PORT` | Server app process | That server app's assigned port; not generated for workers |
| `HOST` | Server app process | `0.0.0.0`; not generated for workers |
| `ASTRO_DEV_BACKGROUND` / `ASTRO_PREVIEW_BACKGROUND` | Per-app process | Default `1` keeps Astro in the foreground under buncargo supervision; override in `staticEnv` or `envVars` |
| `BUNCARGO_APP_NAME` | Per-app process | The app's key in `apps`, so a framework plugin knows which app it is |
| `BUNCARGO_APP_HOSTNAME` | Per-app process | That app's named host (only when loopback named hosts are active) |

Service `env` maps (`url` / `port` / `secondaryPort`) add more shared names. App `staticEnv` and `envVars` are injected only into that app.

### Infisical secrets

An app whose own secret loader shells out to the Infisical CLI at startup runs that CLI once per app, and concurrent Infisical CLI processes hang. Declare the scope instead, and buncargo fetches it once per distinct scope, serialized machine-wide so parallel worktrees queue rather than race. Startup prefetches the selected app scopes and applicable seed/migration scopes before containers, so HTTP fetches overlap preparation. `--up-only` skips this work. The `secrets` timing phase reports time consumers wait, summed across consumers; it can overlap migration, seed and readiness phases. Failed fetches are reported once per scope by consumers. The CLI session token is shared across scopes on the same site and binary for the life of the process; organization exchanges remain scoped. Failed token reads are evicted so a later call after login retries. It hands the values to the child processes, where the app's own loader finds them already in `process.env`.

```ts
defineDevConfig({
  secrets: { projectId: "e5e73966-…", organizationId: "org_…", environment: "dev" },
  apps: {
    api: { port: 3000, devCommand: "bun run api", secrets: { required: ["STRIPE_KEY"] } },
    web: { port: 5173, devCommand: "bun run web", secrets: { projectId: "0be0db90-…" } },
  },
  migrations: [{ name: "search", command: "bun scripts/reindex.ts", secrets: { path: "/search" } }],
});
```

It fetches the way `hanzio/secrets` does, with the same defaults. The CLI is asked only for its session token for `siteUrl`. When `organizationId` names another organization, that token is exchanged for one scoped to it, so projects in different organizations run side by side without `infisical switch`, and the CLI's own session is never switched. The secrets themselves come over HTTP. With `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` (CI), or without them a machine identity in `~/.infisical/universal-auth.json` for the same `siteUrl` (agentgate keeps one there on every machine; `INFISICAL_UNIVERSAL_AUTH_FILE` overrides the path), a universal-auth identity is used instead of the CLI for apps as well as commands. Every consumer of the same scope shares the cached fetch, so machine-auth app startup receives injection too.

**Where secrets go.** Apps get their own scope. Migrations, the seed, `buncargo exec`, `buncargo prisma`, tasks and hooks' `ctx.exec` get theirs too: `migrations[].secrets`, `seed.secrets`, `exec --app=<name>` (that app's scope), otherwise the config-level `secrets`. `secrets: false` turns them off for one app or command, including startup prefetch. Set config-level `secrets: false` to disable all buncargo secret requests for that environment, even when apps, seeders or migrations declare explicit scopes. This is useful when a reusable config is overridden for offline CI. `mergeConfigs(base, { secrets: false })` preserves the opt-out; an explicit scope override can re-enable it. The opt-out controls buncargo fetching; applications still validate their own configuration and must receive synthetic test inputs. Precedence, lowest first: the secrets, then the developer's own exported environment, then the computed env. So `export OPENAI_API_KEY=sk-local` still wins in that shell. Apps without a `secrets` block are untouched by the app injection.

**An expired session stops the run.** Without an Infisical CLI session for a `siteUrl` (none, an expired one, or a CLI that starts its interactive login), `buncargo dev`, `run`, `exec` and library `start()` stop before anything starts, within a few seconds, and name the one fix: `infisical login --domain=<siteUrl>` (in the error's message for `start()`). buncargo's own call to the CLI never logs in: its stdin is closed, a login prompt ends it at once, and it gets 2 seconds. `dev` checks the selected apps' scopes and the config-level one (`--up-only` skips it), `run` and `exec` the scope of the command, `start()` the scopes of what it starts. A machine identity needs no session and skips the check. In CI, and in a shell that exports `INFISICAL_TOKEN` or `INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN` for the apps' own loaders, a missing session only warns, as before. The check is the session token the fetches use anyway, so it adds no CLI process. When the CLI times out or fails and `siteUrl` does not answer either, buncargo is offline or Infisical is down, not logged out: the run warns that Infisical is unreachable and goes on, and each app's own loader fetches its own. A 403 is no login problem either: the warning names the project and the session's organization, and the fix is `secrets.organizationId` or the project's access.

**Other fetch failures.** A signed-in fetch that fails (a missing project or environment, no access, the network) warns once per scope and continues with environment/computed values. Apps can fall back to their own loader; `secrets.required` prevents startup when declared required keys are still absent. Commands retain responsibility for validating their inputs. Machine HTTP failures never switch to CLI authentication.

**What each scope injects.** `dev` and `start()` print one line per scope naming the keys it injects, never a value, so a key someone adds to the shared Infisical environment shows on the next start instead of silently reaching every checkout. `only: ["DATABASE_URL", …]` injects just those keys, and `exclude: ["RESEND_API_KEY"]` drops some; both are scope fields, inherited from the config-level `secrets` like the others, and apply to every command that reads the scope. When the shell's `SECRETS_ENV` picks a non-`dev` environment (a `SECRETS_ENV=prod` left over from a deploy), that line is a warning: set `secrets.environment` in dev.config.ts, or unset it.

**Required keys.** `secrets.required` names keys an app cannot start without. A run with any of them missing (from Infisical, the environment and the computed env alike) stops before anything spawns, naming each app's missing keys.

**Commands.** `buncargo secrets ls [--app=api] [--env=prod]` lists key names, never values, each with the source of the value the app gets: Infisical, env override, computed (buncargo's own env, which wins) or missing. It exits 1 when a required key is missing by the same rule `dev` refuses to start on, so an exported empty value counts as missing. `buncargo secrets check [--json]` reads every scope the config uses (the config-level one and each app's) and prints one line per scope with its key count, never a key or value. Its exit code means one thing each: 0 every scope is readable (or the config uses none), 2 there is no usable session (run the printed `infisical login --domain=…`), 3 a scope cannot be read: unreachable, refused (403) or missing (the line says why), 1 the command itself could not run. `--json` prints `{ ok, exitCode, logins, scopes: [{ projectId, environment, path, siteUrl, organizationId?, usedBy, ok, keys?, error?, fix? }] }`. There is no command that prints a secret value. `buncargo setup` and `buncargo doctor` check that every scope is readable and print the fix (`infisical login --domain=…`, MFA).

Apart from a missing session, a failed fetch warns once and continues; an app's own loader then does what it does today. Values are never logged, never written to a state file, and never included in an error: neither the CLI's output nor a response body is echoed. An empty value is never injected, since a blank variable would read as "already set".

Defaults: `siteUrl` is `https://eu.infisical.com` (like hanzio; it was `app.infisical.com` before the next major), `environment` is `SECRETS_ENV` or `dev`, `path` is `/`.

### Vite plugin

`buncargoVite()` configures the Vite dev server from the variables above, which removes the three things a Vite app in a buncargo repo otherwise hand-writes:

```ts
// apps/web/vite.config.ts
import { buncargoVite } from "buncargo/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [buncargoVite(), react()],
});
```

It sets `server.port` from `PORT`, binds `server.host` to `127.0.0.1` (Vite's default `localhost` resolves to `[::1]` on many systems, so anything dialing IPv4 gets a refused connection), and passes the named-hosts suffix through to `server.allowedHosts`. The frp proxy rewrites the upstream Host to localhost, so remote URLs need no extra allowed-hosts entry. HMR stays origin-relative and follows the HTTPS URL that loaded the page.

The port is also set with `server.strictPort`: a Vite that drifts to the next free port is one nothing is routed to. `FRONTEND_PORT` wins over `PORT` when set, which is what Shopify CLI hands its frontend web, so the same `vite.config.ts` works under buncargo and directly under `shopify app dev`.

Vite is not a dependency of buncargo: the plugin's return type is declared structurally, so importing it costs nothing in a repo without Vite. It listens on `127.0.0.1`, or on `0.0.0.0` when other machines open the app: `BUNCARGO_URL_HOST` is set, or the machine is on a Tailscale network (unless `BUNCARGO_TAILNET_DIRECTORY=0`). Override the app or the bind address when you need to: `buncargoVite({ app: "web", host: "0.0.0.0" })`.

**Proxying `/api` to another app.** `buncargoVite({ proxy: { "/api": "api" } })` adds a `server.proxy` entry targeting the `api` app's loopback URL (`API_LOOPBACK_URL`, else `API_PORT`), with WebSockets on and the incoming Host kept (`changeOrigin: false`), so the API sees the public hostname behind a tunnel. Write this rather than a hand-rolled proxy to `API_URL`: with named hosts on, that URL is `https://api.<project>.localhost`, and a proxy that keeps the Host sends the request back through the hosts daemon to the Vite it came from, which answers `508 Loop Detected`. A tunnel-first project that does not want named URLs at all can set `options.hosts: false`.

### Next.js

`withBuncargo()` wraps a Next config so `next dev` accepts the origins a buncargo run serves the app from:

```ts
// apps/web/next.config.ts
import { withBuncargo } from "buncargo/next";

export default withBuncargo({ reactStrictMode: true });
```

Next answers a 403 to requests for its scripts and its HMR socket from any host outside `allowedDevOrigins`, and by default allows only `localhost` and its subdomains. Without the wrapper, a page opened by the machine's Tailscale address (as BuncargoBar does on a tailnet), through `BUNCARGO_URL_HOST`, on a hosts `tld` other than `localhost`, or through a `--expose` tunnel loads its HTML and nothing else. The wrapper adds those hosts to `allowedDevOrigins`, and the tunnels' hosts to `experimental.serverActions.allowedOrigins`. Origins the config lists itself are kept. A config function (`withBuncargo(async (phase) => ({ … }))`) works too, and only `next dev` sees the change, so a `next build` run inside a buncargo environment stays clean.

`next dev` reads `PORT`, so the app needs no port flag. It compiles a route on its first request, so wait for its ready line rather than a health request:

```ts
web: { port: 3000, cwd: "apps/web", devCommand: "next dev", readyWhen: /Ready in/ },
```

Next is not a dependency of buncargo, and the wrapper imports nothing from it.

### Read by buncargo

| Variable | Meaning |
| --- | --- |
| `BUNCARGO_PORT_OFFSET` | Hard port offset; skips probing |
| `BUNCARGO_URL_HOST` | Host in app URLs (`<APP>_URL`, the banner, `url`, `open`, `status`), for a machine people reach from another one, such as `worker.<tailnet>.ts.net`. Service URLs, health checks and `<APP>_LOOPBACK_URL` stay on `localhost`. Vite apps then accept that host, and the Vite plugin listens on `0.0.0.0`. A browser gives a plain `http://` page on that host no secure context (no `crypto.randomUUID`, clipboard or service workers), so `url` warns, and `url <app> --local` prints the loopback URL for a browser on this machine |
| `BUNCARGO_TAILNET_DIRECTORY` | `0`: do not list this machine's runs to BuncargoBar on the other machines of its tailnet (see [watchdog](#watchdog)), and keep its Vite apps on `127.0.0.1` |
| `BUNCARGO_LOCAL_IP` | Address for the `<app>Local` URLs instead of the first network interface's |
| `BUNCARGO_PRUNE_DELETED_CHECKOUTS` | `1`: the sweep also removes the volumes of a checkout whose directory is gone (see [watchdog](#watchdog)) |
| `BUNCARGO_SYSTEMD_SCOPE` | `0`: on Linux, start the watchdog, `dev --detach` runs and the sharing coordinator in the caller's cgroup instead of a systemd user scope of their own |
| `BUNCARGO_CONTAINER_RUNTIME` | `docker` \| `apple` \| `auto`; overrides `docker.runtime` |
| `BUNCARGO_CONTAINER_BINARY` | Absolute path to the selected runtime's binary; skips the PATH lookup. `docker.binary` wins over it |
| `BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS` | Delay between starting tunnels (default `900`) |
| `BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS` | Tunnel retries (default `5`) |
| `BUNCARGO_QUICK_TUNNEL_RETRY_BASE_MS` | Backoff base (default `2000`) |
| `BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS` | Wait for a `*.trycloudflare.com` URL (default `30000`; `0` disables) |
| `BUNCARGO_CLOUDFLARED_PATH` | Absolute `cloudflared` binary; skips download |
| `BUNCARGO_HOSTS` | `0` forces `http://localhost:port` even when `options.hosts` is on; `tailscale` serves each app's named URL through Tailscale Serve instead of the loopback daemon ([Named URLs over Tailscale](#named-urls-over-tailscale)) |
| `BUNCARGO_MKCERT_PATH` | Absolute `mkcert` binary; skips PATH lookup and download |
| `BUNCARGO_MKCERT_VERSION` | GitHub release tag for the bundled `mkcert` download (default `v1.4.4`). Another tag installs only when its GitHub release publishes the asset's sha256; otherwise point `BUNCARGO_MKCERT_PATH` at an mkcert you installed |
| `BUNCARGO_SYNC_HOSTS` | `0` skips writing the `# buncargo-start` / `# buncargo-end` block in `/etc/hosts` |
| `BUNCARGO_INFISICAL_PATH` | Absolute `infisical` binary; skips the PATH lookup |
| `SECRETS_ENV` | Infisical environment slug when an app's `secrets` scope does not name one (default `dev`) |
| `BUNCARGO_TYPECHECK_CONCURRENCY` | Max overlapping workspace typecheck processes (positive integer) |
| `BUNCARGO_CHECK_SLOTS` | Typechecks, `slot` and `exec --slot` commands that may run at once across every checkout of this user on the machine (default `3`, `0` turns the cap off) |
| `BUNCARGO_TIMING` | `1` prints a per-phase breakdown of `dev` startup (same as `--timing`) |
| `CLOUDFLARED_VERSION` | GitHub release tag for the bundled download (default `2026.3.0`). Another tag installs only when its GitHub release publishes the asset's sha256 |
| `CI` | Skips Docker auto-start; also disables named hosts. Detected from `CI=1` / `CI=true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL` |

Every variable above is read through [`src/core/runtime-flags.ts`](../src/core/runtime-flags.ts) on each call, so a flag exported mid-session applies to the next command without a restart.

## Configuration Reference

The configuration reference covers the main public options; `src/types/all-types.ts` is the complete type contract.

### `DevConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectPrefix` | `string` | required | Compose/project prefix. Must start with a letter and be lowercase/`0-9`/`-`. Example: `"gey"` |
| `services` | `Record<string, ServiceConfig>` | required | Container services; `{}` permits app-only configurations. |
| `apps` | `Record<string, AppConfig>` | `undefined` | Servers and portless workers to orchestrate |
| `env` | `(ports, urls, ctx) => Record<string, string \| number>` | `undefined` | Shared overlay merged onto computed ports/urls for every process |
| `hooks` | `DevHooks` | `undefined` | Lifecycle hooks |
| `migrations` | `MigrationConfig[]` | `[]` | Selected custom migrations, in order after automatic Prisma migrations for the selected database |
| `seed` | `SeedConfig` | `undefined` | After migrations, before servers |
| `prisma` | `PrismaConfig` | `undefined` | Enables `dev.prisma` and `buncargo prisma` |
| `options` | `DevOptions` | `undefined` | Isolation, watchdog, helper app names |
| `docker` | `DockerComposeGenerationOptions` | `undefined` | Generated compose path, volumes, Docker auto-start |
| `secrets` | `SecretsScopeConfig` | `undefined` | Defaults for every app's `secrets` scope |
| `setupChecks` | `{ name, check: ({ root }) => boolean \| Promise<boolean>, fix? }[]` | `[]` | Preconditions `dev` verifies first. See [checks](#checks-tasks-and-profiles) |
| `preflight` | `{ name, apps?, run(ctx) }[]` | `[]` | Steps `dev` runs with the terminal before starting. See [preflight](#preflight) |
| `tasks` | `Record<string, { command, description?, app?, cwd?, requiredServices? }>` | `{}` | Scripts for `buncargo run <name>` |
| `profiles` | `Record<string, { apps, description? }>` | `{}` | App selections for `dev --profile`; `default` is used by a bare `dev` |
| `integrations` | `BuncargoIntegration[]` | `[]` | `shopify()`, `expo()`, …; applied in order before validation |
| `generatedFiles` | `{ path, render(ctx), gitignore? }[]` | `[]` | Files rendered from ports, URLs and captures. See [captures](#captured-output-and-generated-files) |
| `typecheck` | `{ include?, exclude?, concurrency?, groups?, scripts? }` | `undefined` | Directories `buncargo typecheck` checks beyond discovery, workspaces it leaves out, and named groups. See [typecheck](#cli-reference) |
| `check` | `{ gates?, testCommand?, testExclude?, testAlso?, testDeferred?, docs?, format? }` | `undefined` | Gates and tests for `buncargo check`. See [check](#buncargo-check-and-buncargo-predeploy) |
| `predeploy` | `{ environmentVars?, production?, seedIn?, seed?, retry?, beforeMigrate?, afterMigrate?, afterSeed?, onFailure? }` | `undefined` | Settings and hooks for `buncargo predeploy`. See [predeploy](#buncargo-check-and-buncargo-predeploy) |
| `unsetEnv` | `string[]` | `[]` | Variables removed from every process buncargo starts (apps, tasks, `exec`, migrations, the seed), e.g. those tools use to detect an agent's shell; a tool run through `exec` loses its own agent detection. The Prisma CLI `buncargo prisma` runs keeps them. buncargo's own environment is unchanged |

Use the top-level `env` overlay for shared values (rewritten `WEB_URL`, `VITE_*`), and `apps.<name>.envVars` for app-only values.

### `ServiceConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `"service" \| "job"` | `"service"` | Long-running container or finite command |
| `rerun` | `"always"` | required for jobs | Explicitly allow execution on subsequent starts |
| `afterPreparation` | `boolean` | `false` | Start after migrations, generation, hooks and seed |
| `port` | `number` | omitted | Base host port; omit for an internal container or job |
| `expose` | `boolean` | `false` | Eligible for `--expose` |
| `secondaryPort` | `number` | `undefined` | Extra host port (ClickHouse native). Exposed as `ports.<name>Secondary` |
| `bind` | `string` | `"127.0.0.1"` | Address its ports are published on. `"0.0.0.0"` lets other machines reach it, such as a database you open from another computer. A raw `docker.ports` list is published as written |
| `healthCheck` | `"pg_isready" \| "redis-cli" \| "http" \| "tcp" \| (port) => Promise<boolean> \| false` | preset default | `tcp` is a real TCP connect from the host and emits no container healthcheck. `false` disables |
| `healthTimeout` | `number` | `30000` | Per-service health poll timeout (ms) |
| `urlTemplate` | `(ctx: UrlBuilderContext) => string` | the preset's URL, else `http://localhost:<port>` | Connection URL builder |
| `serviceName` | `string` | the config key | Compose service name |
| `database` | `string` | preset default | Database the Postgres or ClickHouse preset creates and its URL names. Presets only |
| `user` | `string` | `postgres` / `default` | The preset's user. Presets only |
| `password` | `string` | `postgres` / `clickhouse` | The preset's password. Presets only |
| `env` | `Record<string, "url" \| "port" \| "secondaryPort">` | preset aliases | Shared env outputs |
| `staticEnv` | `Record<string, string>` | `{}` | Constant shared env (API keys, `SMTP_HOST`) |
| `docker` | preset helper or raw Compose service | the preset its key names, for a key `postgres`/`redis`/`clickhouse`/`mailpit`/`typesense`/`minio` | Image, ports, healthcheck, volumes. A raw definition is taken as written, under any key |
| `external` | `{ stack, preset? }` | `undefined` | Provided by an integration's stack (the Supabase CLI) instead of the Compose file: allocated a port, URL and env, never written to Compose. `preset` says what it is (TablePlus link), without the preset's default env. Selecting one of a stack's services selects them all |

`UrlBuilderContext`: `{ port, secondaryPort?, host, localIp }`. See [portless containers and finite jobs](#portless-containers-and-finite-jobs) for completion and rerun behavior.

A service's preset is what it is. `db: service.postgres()` and a bare `postgres: { port: 5432 }` are the same service: the preset's image, probe, `DATABASE_URL` and `postgresql://` URL. A raw `docker` definition is a custom container whatever its key, with an `http://` URL unless it sets `urlTemplate`; to change a preset's image or Compose fields, pass them to the helper: `service.postgres({ docker: { image: "postgis/postgis:16" } })`.

Validation rejects a key no section takes, so a misspelt `healthEndpont` fails instead of being ignored, and names the replacement for a renamed one.

### `AppConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `"server" \| "worker"` | `"server"` | HTTP server or process without an endpoint |
| `port` | `number` | required for servers | Base host port; prohibited for workers |
| `devCommand` | `string \| false` | required | Start command. `false` reserves/tunnels the port without starting a process |
| `prodCommand` | `string` | `devCommand` | Production start command |
| `buildCommand` | `string` | `undefined` | Production build command |
| `cwd` | `string` | repo root | Working directory relative to root |
| `healthEndpoint` | `string \| false` | `"/"` | HTTP path to wait on. `false` skips the wait |
| `healthTimeout` | `number` | `60000` (`120000` in CI) | App readiness timeout (ms) |
| `readyWhen` | `RegExp` | `undefined` | Ready once the app's output matches, instead of its `healthEndpoint`. See [ready by output](#ready-by-output) |
| `watch` | `{ paths, ignore?, debounceMs? }` | `undefined` | Restart with a fresh process when these paths change. See [watching files](#watching-files) |
| `entryPath` | `string` | `undefined` | Path people start at, e.g. `/app/`. Added to what `open`, `url`, the banner and BuncargoBar show; URL env vars stay origins |
| `requiredServices` | `string[]` | `[]` | Service keys that must be up |
| `requiredApps` | `string[]` | `[]` | Apps that must also start (transitive). Selection only: they are not ready first |
| `startAfter` | `string[]` | `[]` | Spawn once these apps are healthy; also selects them |
| `prebuild` | `string` | `undefined` | Command run to completion before `devCommand` |
| `captures` | `Record<string, { pattern, as, label?, env?, secret? }>` | `{}` | Values picked from output: `publicUrl`, `value` or `event`, optionally shown under `label` and set as `env`. `secret` keeps one out of the run registry |
| `restartOn` | `string[]` | `[]` | `captured.<name>` / `publicUrls.<app>` changes that restart this app |
| `exclusive` | `string` | `undefined` | Machine-wide lease key; see [leases](#exclusive-leases) |
| `expose` | `boolean` | `false` | Eligible for `--expose` |
| `staticEnv` | `Record<string, string \| number>` | `{}` | Constant env for this app only |
| `envVars` | `(ports, urls, ctx) => Record<string, string \| number>` | `undefined` | Computed env for this app only |
| `secrets` | `{ projectId?, organizationId?, environment?, siteUrl?, path?, required? }` | `undefined` | Fetch this app's Infisical secrets once and inject them. See [Infisical secrets](#infisical-secrets) |
| `interactive` | `boolean` | `false` | Own the TTY in stream mode. Only one app may set this; the TUI ignores it |
| `essential` | `boolean` | `true` | `false`: the run keeps going when this app exits; `r` / `buncargo restart` starts it again |
| `stopGraceMs` | `number` | `5000` | Time between SIGTERM and SIGKILL on stop, restart, takeover and `buncargo stop`. Raise it for a process that saves data as it exits |
| `extraPorts` | `number[]` | `[]` | Base ports the app also listens on. Moved by the checkout's offset and claimed and checked with its block; no env vars or URLs. Servers only |
| `actions` | `{ key, label, open }[]` | `[]` | Keys that open a captured URL from the TUI footer. Unique, and not `o e r l q j k` |
| `needsPublicUrls` | `boolean` | `false` | Start after tunnels so env sees `*_PUBLIC_URL`. Ignored without `--expose` |

Use `kind: "worker"` for a long-running process without a listener. Workers require a command and reject port, HTTP-health, exposure and Expo options.

`envVars` context: `{ projectName, localIp, portOffset, publicUrls, loopbackUrls, env }`; `env` is the resolved input snapshot.

### `DevOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `worktreeIsolation` | `boolean` | `true` | Unique ports and compose project per worktree |
| `autoShutdown` | `number \| false` | `180000` | How long containers are held after the run exits, in **ms**. `false` keeps them as long as the checkout exists (same as `--keep-containers`) |
| `envFiles` | `(string \| { path, optional? })[]` | `[]` | Root dotenv input defaults; later files win, generated local values stay authoritative |
| `envFile` | `boolean \| { path?, createFrom? }` | `false` | Sync a dotenv to the allocated ports. `true` means `.env` |
| `checkoutFiles` | `(string \| { path, template?, machine? })[]` | `[]` | Gitignored files every checkout gets from this machine's file store. See [checkout files](#checkout-files) |
| `verbose` | `boolean` | `true` | Default verbosity |
| `onAppFailure` | `"keep-others" \| "stop-run"` | `"keep-others"` | What `buncargo dev` does when an app does not become ready. See [when an app does not come up](#when-an-app-does-not-come-up) |
| `primaryApp` | `string` | inferred | The app this project is "about": the menu bar's Open button, the TUI's `o`, and the bare named hostname. Inferred from the dependency graph when unset (but the bare hostname is only ever given to a configured one) |
| `hosts` | `boolean \| HostsOptions` | `undefined` (off) | Named `.localhost` HTTPS URLs. `true` uses TLD `localhost` and names Mailpit/Typesense. `{ tld, services }` for a custom TLD or extra HTTP service UIs |

### `DockerComposeGenerationOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `generatedFile` | `string` | `.buncargo/docker-compose.generated.yml` | Path relative to root |
| `writeStrategy` | `"always" \| "if-missing"` | `"always"` | Atomic write when content changes; `if-missing` rejects an existing file that differs from the model |
| `volumes` | `Record<string, DockerComposeVolumeRaw>` | `{}` | Extra top-level named volumes |
| `autoStart` | `boolean` | `true` (skipped in CI) | Try to start Docker if the daemon is down |
| `runtime` | `"docker" \| "apple" \| "auto"` | `"docker"` | Which container runtime runs the services (see [Container runtime](#container-runtime)) |
| `binary` | `string` | PATH lookup | Absolute path to the selected runtime's binary (`docker` or `container`) |
| `startCommand` | `string` | `undefined` | Shell command that starts a Docker daemon buncargo cannot start itself (the plain Linux engine in a VM without a service manager); run when auto-start applies, then waited for |

Generated compose includes `name: ${COMPOSE_PROJECT_NAME}` and labels `buncargo.project`, `buncargo.root`, `buncargo.worktree`, `buncargo.service`.

The automatic Prisma migration step checks migration folders containing `migration.sql` against `_prisma_migrations` using Bun SQL and the local Postgres service. If every migration is successfully applied, it prints `Migrations up to date (N)` and skips the CLI. This is only a startup shortcut: missing tables/directories, failed or rolled-back rows, connection errors, other service presets, and overridden database URLs all run `migrate deploy` as usual. The migrations timing phase includes the check. For a custom directory, set e.g. `prisma.migrations: "schema/migrations"`.

### `PrismaConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | `packages/prisma` | Schema directory |
| `migrations` | `string` | `prisma/migrations` | Migration directory relative to `prisma.cwd`; also the default for `migrate-check` |
| `schema` | `string` | `prisma/schema.prisma` | Schema file or folder relative to `prisma.cwd`, for `migrate-check` and `migration new` |
| `service` | `string` | `postgres` | Service key for `DATABASE_URL` |
| `urlEnvVar` | `string \| string[]` | `DATABASE_URL` | Env var name. A list sets each name to the database URL (`["DATABASE_URL", "DATABASE_URL_DIRECT"]`); buncargo reads the URL from the first |
| `generate` | `string` | skipped | Command after migrations (e.g. `bunx prisma generate --schema ./schema --sql`) |
| `generateCheck` | `"schema-hash" \| (ctx) => boolean \| Promise<boolean>` | always generate | `"schema-hash"` generates only when the `.prisma` files under `prisma.cwd` changed since buncargo last generated. A function returns `true` when generation is needed, and must verify all inputs and outputs itself |

### `MigrationConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `requiredServices` | `readonly string[]` | any selected service | All listed services must be selected; `[]` permits app-only preparation |
| `name` | `string` | required | Display name |
| `command` | `string` | required | Shell command |
| `cwd` | `string` | repo root | Working directory |
| `secrets` | `SecretsScopeConfig \| false` | config-level `secrets` | Infisical scope for this command |

Set `seed.beforeApps: false` to overlap the seed and app startup. `afterServers`, the ready message, and library `start()` completion all wait for the seed as well as app health. A seed failure fails the run and stops its apps; concurrent seed output uses the `seed` app-style prefix. When any selected service has `afterPreparation`, buncargo keeps seed and apps serial and explains why. `--seed` and other one-shot modes retain their existing order. Startup phase durations can overlap in this mode.

### `SeedConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `requiredServices` | `readonly string[]` | any selected service | All listed services must be selected; `[]` permits app-only preparation |
| `command` | `string` | required | Seeder command (`buncargo dev --seed` uses this) |
| `cwd` | `string` | repo root | Working directory |
| `check` | `(ctx) => Promise<boolean>` | always run | Return `true` to seed. `checkTable(table)` defaults its service to `prisma.service ?? "postgres"` |
| `forceExit` | `boolean` | `true` for `bun ./file.ts` commands | Exit the seed process after the module finishes, even if sockets/pools are still open |
| `secrets` | `SecretsScopeConfig \| false` | config-level `secrets` | Infisical scope for the seeder |
| `beforeApps` | `boolean` | `true` | `false` runs the seed alongside apps after migrations and container hooks; readiness waits for both |

### `DevHooks` and `HookContext`

| Hook | When |
| --- | --- |
| `beforeMigrations` | After selected database readiness, before automatic Prisma and custom migrations |
| `afterContainersReady` | After early containers, dotenv sync, migrations, and generation; before seeding |
| `beforeServers` | Before app processes start |
| `afterServers` | After health waits succeed |
| `beforeStop` | Before `stop()` |
| `onCapture` | An app printed a value one of its `captures` matched: `(event, ctx)` |

`HookContext`: `{ projectName, ports, urls, publicUrls, captured, exec, root, isCI, portOffset, localIp, signal, selectedApps, selectedServices }`. Migration and seed entries accept `requiredServices` to scope preparation; all listed services must be selected.

`exec(cmd, { app?, cwd?, verbose?, env?, throwOnError?, signal?, timeoutMs?, killGraceMs? })` accepts a shell command string or an argv array and returns `{ exitCode, stdout, stderr }`. See [checkout execution](#execute-with-the-checkout-environment).

### `StartOptions` / `StopOptions`

`start({ verbose, wait, startServers, productionBuild, seed, schema, claim, onlyApps, onlyServices, autoStartDocker, replaceStaleStacks, watchdog, signal, prepare, onPhase })` resolves to the apps' process IDs by app name (`DevServerPids<TApps>`), or `null` when it spawned none.

`seed` is `"auto"` (default: when `seed.check` says so, beside the apps with `seed.beforeApps: false`), `"force"` (before the apps, whatever `seed.check` says) or `"skip"`. `schema: "push"` runs `prisma db push` in place of `prisma migrate deploy`, for a throwaway database; the other `migrations` and the hooks run as usual. `claim: { idleTimeoutMs }` is the hold the run claims its containers with, as `claimRun()` sets it.

`replaceStaleStacks` is `dev --replace-stale`: before the ports are allocated, it removes the containers and networks of stacks this checkout left under a project name it no longer uses and that hold this run's ports. That happens after `projectPrefix` changes: the old stack keeps running under the old name. Its volumes are kept. A stack with containers of another checkout, or one a live run still uses, is never touched. A checkout with two configs of different `projectPrefix` would see each other's stacks as stale; give each its own directory.

`onlyServices` starts those services (plus Compose dependencies) and no apps; it is what `buncargo run` and `buncargo ci` use.

`productionBuild` runs each app's `buildCommand` and `prodCommand` and gives the containers, migrations, seed and apps `NODE_ENV=production`. It defaults to `true` in CI when `start()` runs the servers and `false` otherwise, so `start({ startServers: false })` prepares for the development processes `startServers()` and `exec()` run. `buncargo dev` is always development.

`stop({ verbose, removeVolumes, force, signal })` stops this environment's apps, then its services. While another live run of the project in this checkout uses those services, they stay up for it and `stop()` only releases this environment's claim; `force: true` tears them down anyway.

`withServices(names, options, command)` starts those services for a command and releases them however it ends: the run is claimed before the first container, with `options.claim`'s hold, and `command` gets `{ seed }` (a forced seed's outcome). `options` takes `signal`, `verbose`, `wait`, `watchdog`, `onPhase`, `prepare` (`"containers"`, the default, or `"all"` for migrations and the seed), `seed`, `schema`, `claim` and `after` (`"release"`, or `{ stop: { removeVolumes } }` to tear the services down instead). `buncargo run`, `sql`, `prisma` and `ci` start their services this way.

```ts
await env.withServices(["postgres"], { claim: { idleTimeoutMs: 60_000 } }, async () => {
  await env.exec("bun test", { throwOnError: true });
});
```

### `CliOptions` (programmatic `runCli`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `args` | `string[]` | `process.argv.slice(2)` | CLI flags |
| `watchdog` | `boolean` | `true` | Start the watchdog that removes this run's containers once it is gone. The run claims its containers either way; `false` only skips starting the process. Tests set `false`. The idle hold comes from `options.autoShutdown`, `--keep-containers`, or `--watchdog-timeout`. |

## Health Checks

| Type | Behavior |
| --- | --- |
| `pg_isready` | Postgres readiness |
| `redis-cli` | Redis `PING` |
| `http` | HTTP GET |
| `tcp` | Real TCP connect to the published port |
| function | Custom `(port) => Promise<boolean>` |
| `false` | Skip |

Raise `healthTimeout` on the service if a cold start can exceed 30s (ClickHouse often does).

Server app readiness uses `healthEndpoint` (HTTP). Set `healthEndpoint: false` for Metro/Expo. Workers are ready when spawned and alive; portless containers use runtime process state, and finite jobs require successful completion.

HTTP app health checks probe `http://localhost:<port>`, including when the app has a named HTTPS URL. This keeps readiness and reused-process detection independent of local certificate trust.

## Public tunnels

Mark targets with `expose: true`, then `bunx buncargo dev --expose` or `--expose=api,web`.
A tunnel lives as long as the run: `--migrate`, `--seed` and `--up-only` ignore
`--expose` (and `--takeover`) with a warning, since their tunnels would close as they exit.

`expose` only governs these public tunnels: remote sharing includes every selected app and service with a host port.

Tunnels open **after** wave-1 apps are healthy and **before** `needsPublicUrls` apps spawn, so Expo can read `EXPO_PACKAGER_PROXY_URL` at start. Public URLs are normalized (trailing slash stripped). Without `--expose` there is no second wave at all.

Reuse: if an exposed app is already healthy because another live run in this checkout serves it on the same port, the public URL that run publishes for it is inherited.

`--expose` still wins: `publicUrls` / `*_PUBLIC_URL` are the only public addresses. Named hosts are loopback-only.

Programmatic: `openPublicTunnels({ names?, waitForHealthy? })` then `buildAppEnvVars(name)`.

## Watchdog

Every run that owns containers claims them in `~/.buncargo/runs.json` before it starts them, and one watchdog per machine (`dist/core/watchdog-runner.js`, log in `~/.buncargo/watchdog.log`) sweeps every buncargo container against that registry every 30s. Runs started from a script with `dev.start()` get it too; pass `start({ watchdog: false })` to skip starting the process. A script's containers stay up after it exits — `options.autoShutdown` and the three-minute default are `buncargo dev`'s — unless it asks for a hold with `claimRun({ idleTimeoutMs })` before `start()`, or it reused the containers a `dev` run left in its idle hold, whose hold then still applies. The watchdog also stops [detached runs](#cli-reference) that sat idle for 2 hours or whose checkout was deleted. `buncargo ls` and `doctor` run the same sweep inline, so a killed watchdog is never the last line of defence. The sweep only removes a stack your own buncargo state names: a run in your `~/.buncargo/runs.json` or a port claim in your `~/.buncargo/offsets.json` for its project and checkout. Such a stack is removed when:

- **its checkout is gone** - the worktree was deleted and no live run holds the stack. A checkout this user cannot read (another user's home) is not gone
- **it is stopped and nobody owns it** - a daemon restart or `buncargo stop <service>` left it exited and the run has ended
- **its run exited cleanly** (Ctrl-C leaves a `released` marker) and the idle hold has passed - 3 minutes by default, so a quick restart reuses the containers rather than recreating them
- **its run crashed** (the PID is gone without releasing) and ~15s have passed since a sweep first noticed
- **a script reused it from a held run** - a `dev.start()` that asked for no hold reused containers a `dev` run had left in its idle hold: they come down that hold after the script ends, as they would have after the `dev` run

Any other stack is left alone, however it looks: on a machine where several users share one Docker daemon, another user's stacks are listed too, and from your account their checkouts look unowned or deleted. `buncargo ls` and `doctor` mark each as not yours, with the command that removes it by hand (`docker compose -p <project> down`, or `container delete --force <ids>` for Apple container) if it really is orphaned, for example after `~/.buncargo` was wiped. Volumes stay either way. `dev --down --all` follows the same rule: it removes your stacks and lists the others with those commands.

Each `watchdog.log` line starts with the watchdog's buncargo version and pid (`[watchdog 13.0.0 pid 4242]`), and each removal names the run it was decided against: `Removed shop's containers (/work/shop, docker): owner gone for 16s; its run: session …, pid 4242, worktree feature, branch feature/login`. `ls`, `doctor` and `prune` report their removals the same way.

Every removal, by the sweep, `stop`, `dev --down` or `stop()`, is recorded in `~/.buncargo/events.json` (the last 500, with the detached runs the watchdog stopped): when, which project and checkout, why, the run it was decided against, and the command, pid, user and buncargo version that did it. When a run fails without its containers (`ci`'s command or seed, an app of a `dev` run exiting with an error, a library `startServers()` or `waitForServers()`), it prints who removed them since it claimed them, or, when nothing here recorded it, the time window and where to look: other users' `~/.buncargo/watchdog.log` and `docker events`. A library caller can ask the same with `explainMissingContainers()`.

A running stack with a live owner is never touched. `--keep-containers`, `options.autoShutdown: false` and the one-shot modes (`--up-only`, `--migrate`, `--seed`) set no idle hold, so their containers live as long as the checkout — even if the run crashed. `--watchdog-timeout=N` sets the hold in minutes. The watchdog exits when no container and no live run is left to watch, and any later `dev` starts it again. A run of a newer buncargo replaces a watchdog started by an older one, so one worktree on an old version does not sweep the others with old rules; an older buncargo leaves a newer watchdog alone.

On a machine on a [Tailscale](https://tailscale.com) network, the watchdog also lists the live runs at `http://<tailscale-ip>:48480/v1/runs`, on the Tailscale address only, so BuncargoBar on your other machines shows them. A run with no containers, `buncargo dev` or a `start()` that spawns apps, starts the watchdog too once its apps are up, so it is listed as well (`start({ watchdog: false })` skips it). Who can read it is up to your tailnet's access rules; the list includes connection strings with the dev database passwords. `BUNCARGO_TAILNET_DIRECTORY=0` turns it off, and keeps Vite apps on `127.0.0.1`.

A finished run keeps its registry entry until its containers are gone — that entry is what says they may still be reused, and for how long. `buncargo runs` and the menu bar filter it out; the sweep and `stop` see it, and `stop --all` removes its containers now. `dev --down`, `stop --all` and `stop()` remove the entry straight away, since they have just removed the containers.

**Volumes are never removed automatically.** A container costs nothing to recreate; a volume is the database. `buncargo prune` lists the volumes of checkouts whose directory was deleted, when no container, no run and no other checkout uses their project, and removes them only after you confirm. That includes the volumes of a deleted checkout's E2E and other suffixed stacks. A volume nothing on record ties to a deleted checkout stays, and so does an idle checkout's database. Before removing, it checks each volume again, so one a run or checkout took up since the listing is kept. `bunx buncargo doctor` says how many there are. A project's `ci` stacks and deleted worktrees are `buncargo prune --project`'s (below):

```bash
bunx buncargo prune --dry-run                  # List what would go
bunx buncargo prune --older-than=7d --dry-run  # Only checkouts deleted a week ago or longer
bunx buncargo prune                            # Review, then confirm
bunx buncargo prune --yes                      # For scripts that have already decided
```

`--older-than` counts from when buncargo first found the checkout gone (`m`, `h` or `d`).

Volumes carry no buncargo labels on purpose: Compose compares a volume against the file and offers to *recreate* it when they differ, which hangs a non-interactive run and destroys the data. So prune cannot tell which checkout a volume came from, and says so rather than guessing — volumes it cannot attribute to a project are counted and left alone.

A machine where worktrees come and go all day, such as a server agents work on, can opt in with `BUNCARGO_PRUNE_DELETED_CHECKOUTS=1`: the sweep then also removes the volumes of a checkout whose directory was deleted, once a pass at least 10 minutes after the first still finds it gone. It works for checkouts whose containers are already gone, and leaves the volumes whenever another checkout or a run still uses the same project name. A deleted checkout's E2E and other suffixed stacks go with it. A checkout your user cannot read never counts as deleted.

The watchdog also reports the volumes `buncargo prune --dry-run` would propose, in `~/.buncargo/watchdog.log`. It checks at most once an hour and writes only when that set changes, and it never removes anything. Only the runtimes that answered that pass are judged, each against its own containers.

The watchdog exits when nothing is left to watch, and the next `buncargo dev` starts one from its own checkout. A machine that wants a standing watchdog on a pinned release, rather than one that follows whichever worktree last ran, can run it as a systemd user service. Use `on-failure`, not `always`: the watchdog exits with status 0 when idle, and `always` would restart it every 30 seconds to find nothing to do.

```bash
mkdir -p ~/.buncargo-watchdog && cd ~/.buncargo-watchdog && bun add buncargo@<version>
```

```ini
# ~/.config/systemd/user/buncargo-watchdog.service
[Unit]
Description=buncargo watchdog (pinned release)

[Service]
ExecStart=%h/.bun/bin/bun %h/.buncargo-watchdog/node_modules/buncargo/dist/core/watchdog-runner.js
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now buncargo-watchdog
```

systemd's user manager reads `~/.config/environment.d/*.conf`, so the `BUNCARGO_*` settings there reach the service. A newer buncargo started from a worktree still replaces this watchdog, as it replaces any older one.

`buncargo prune --project` is the same, for one project: run it in any checkout, and it removes only that project's leftovers, by name. That is every checkout's `ci` stack, and every stack of a worktree whose directory was deleted (until `git worktree prune` forgets it). It takes their stopped containers, volumes and networks:

```bash
bunx buncargo prune --project --dry-run   # List this project's leftovers
bunx buncargo prune --project             # Review, then confirm
```

Each existing checkout's dev stack is kept, and so is any stack with a running container or a live run, and any stack with a container that buncargo did not start from one of this project's checkouts (its `buncargo.root` label). Nothing is forced, so Docker refuses whatever is in use, and if Git, Docker or the run registry cannot be read, nothing is removed. Docker only: Apple `container` records no Compose project on its volumes.

Closing the terminal sends `SIGHUP`; cleanup is awaited and idempotent.

## Troubleshooting

| Error | Cause | Fix |
| --- | --- | --- |
| `Docker is not running` | Daemon down and auto-start failed/disabled | Start OrbStack/Docker/Colima, or drop `--no-docker-autostart`. On Linux: `sudo systemctl start docker` |
| `Docker is running, but this user cannot open its socket` | User not in the `docker` group, or a process started before it was added | `sudo usermod -aG docker $USER`, then log in again or restart the service you run buncargo from |
| `port 5173 held by container gey-other-platform-1 (project gey-other)` | Foreign compose project owns the port | Stop the other env (`buncargo ls` / `dev --down --all`) or let allocation shift |
| `port … held by container bliss-main-redis-1 (project bliss-main), a stale stack of this checkout` | This checkout's stack from before its `projectPrefix` changed still runs under the old name | Run the `docker compose -p <old> down` the message names, or `dev --replace-stale`. Both keep the old stack's volumes |
| `port … held by process …` | Another process owns the port | Stop that process; own-repo orphans are killed automatically |
| `port … is held by an unidentified process` | A process this user cannot list (often a macOS service) holds it | Run `dev` again: allocation moves to a free block |
| `… listens on :8022, not its assigned :8021` | The app moved to the next port because its own was taken | Run `dev` again; set `strictPort` (Vite, Astro's `vite.server`) so it fails instead of moving |
| `--reset removes …'s volumes … Refusing without a terminal` | `--reset` / `--down --all` from a script or agent | Pass `--yes` if that is really meant |
| `prisma migrate reset drops the database … Refusing without a terminal` | `buncargo prisma migrate reset` or `db push --force-reset`/`--accept-data-loss` from a script or agent | Pass `--yes` if that is really meant |
| `… Refusing while DATABASE_URL_DIRECT points at another server` | A destructive Prisma command while an inherited variable holds a Postgres URL on another host or port | Unset the variable, or add it to `prisma.urlEnvVar` |
| `… applied N migrations this checkout no longer has` (exit 4) | The database ran migrations a squash or rewrite removed from the chain | `buncargo dev --reset --yes` recreates the database and drops its data; ask first |
| `Dependencies are installed (no node_modules)` | Fresh worktree | `bun install`, or `buncargo setup --yes` |
| `This project's buncargo (package.json) is not installed` | `bunx buncargo` found a different buncargo than the project lists, and the project's is not installed | `bun install` |
| `bun install --frozen-lockfile failed in <dir>` | The checkout installed itself and `bun.lock` does not match `package.json`, or a postinstall script failed | Fix what the install printed, then `bun install` |
| `Worker "…" is already running` | Library startup encountered an owned worker | Reuse it through the CLI or use `dev --takeover` |
| `Apple container cannot verify finite job exit codes yet` | A job was selected with Apple | Use `--runtime=docker` |
| `already listening on port … but failed health check` | Port busy, `healthEndpoint` failed, and the server runs in another terminal of this checkout or is not from this checkout | `dev --takeover` replaces another run's server; otherwise free the port. A leftover no run owns and a `--detach` run's server are replaced without asking |
| `options.primaryApp "…" must match a configured app key` | Typo or removed app | Point it at a real `apps.<name>` |
| `Only one app may set interactive: true` | Two TTY owners | Keep one `interactive` or use `--attach` |
| `Watchdog did not start` | Missing `dist/core/watchdog-runner.js` | `bun run build` / reinstall the package |
| Disk full of old worktree volumes | Deleted checkouts, and `ci` runs from before their data moved to tmpfs, leave their databases behind | `buncargo prune --project --dry-run` for this project, `buncargo prune --dry-run` for every project; then without `--dry-run` |
| `.env.local has local edits and the file store changed too` | This checkout and another both changed a checkout file | `buncargo files merge .env.local` keeps both sides' keys (dotenv only); `files save` keeps yours, `files pull --force` takes the store's |
| `… would run under Compose project …, which … already uses` | Another checkout with the same project name exists: CI runners in same-named directories, or a config below a worktree's top level | Give one of them its own `projectPrefix` (see [Ports and isolation](#ports-and-isolation)) and start it once, or delete the checkout no longer used. If the other checkout's claim is from a config it no longer runs, `buncargo ports release --root <path>` (the error names the path) |
| `Could not allocate a free port block` | Every block is claimed by checkouts that are running or hold containers, or held by other processes | The error lists each holder. Stop one you no longer need (`buncargo stop --all --root <path>`) and `buncargo ports release --root <path>`, release idle claims (`buncargo ports release --idle=7d`), or `buncargo ports pin <offset>` with the offset it suggests |
| Named URL does not resolve / TLS warning | Daemon down or CA not trusted | `buncargo hosts status`, then `buncargo hosts install` or `doctor --fix` |
| `Docker Desktop is running (pid …) but its daemon is not answering` | Docker Desktop hung; quitting it can leave `com.docker.backend` alive | `buncargo doctor --fix`: once Docker Desktop has run past a cold start without answering, it asks (in a terminal) and force-restarts it, which stops every container on the machine and keeps volumes |
| A port `held by process … in …/.Trash/…` | A dev server of a deleted checkout | `buncargo doctor --fix` stops it |
| `postgres stopped (exit 0)` during a run | A service container went down under the run | The line says which buncargo command stopped it, if one did. Restart the run |
| `search keeps restarting (exit 1)` during a run, or `Service search keeps crashing while starting up` | The container exits and its restart policy brings it back, again and again | Read the container output the message shows (`docker logs <container>`), fix the service's config, then restart the run |
| `Could not stop …'s containers. Docker did not answer` | The daemon refused this user or did not answer, so the containers may still run | Check `docker version`; once it answers, stop again |
| `Tailscale URLs unavailable` with `BUNCARGO_HOSTS=tailscale` | Tailscale down or logged out, HTTPS Certificates off, or no permission to change Serve | `buncargo doctor` names which, and the fix |
| `Named-hosts service points at … which no longer exists` | The install ran from a `node_modules` that was since removed | `buncargo hosts install` to re-point it at the current CLI |
| `Named-hosts service is installed but did not answer on :443` | Daemon started and crashed | `tail /var/log/buncargo-hosts.log`, then `buncargo hosts install` |
| `… is still owned by root` | A `sudo` run wrote a file under `~/.buncargo` and could not hand it back | `sudo chown -R "$USER" ~/.buncargo` |
| `Named hosts need one-time setup` with no prompt | No TTY, so the password prompt was skipped | Run `buncargo hosts install` from a terminal |
| Safari cannot open `.localhost` | `/etc/hosts` missing the names | `buncargo hosts sync` (or leave auto-sync on; `BUNCARGO_SYNC_HOSTS=0` opts out) |
| `508 Loop Detected` | Vite (or similar) proxies `/api` without rewriting Host | Add `changeOrigin: true` to the dev-server proxy config |
| `ERR_CONTENT_DECODING_FAILED` on a named URL | Stale hostsd decoded gzip but kept `Content-Encoding` | `buncargo hosts install` to replace the daemon bundle |
| `Portless is serving :443` (or Caddy / nginx / Docker) | Another proxy owns HTTPS | Stop that process, or set `hosts: false` / `--no-hosts` |
| `ERR_SSL_PROTOCOL_ERROR` in the browser, `hosts status` healthy | Another server shares `:443` on `[::1]`, which browsers try first for `.localhost` | `buncargo hosts status` names it; stop it (`lsof -nP -iTCP:443`) or set `hosts: false` |

`doctor` also reports the machine's open-file table and, once it is half full, the processes holding the most descriptors: near the limit every tool fails with ENFILE, usually because of a process in another checkout.

`bunx buncargo doctor` checks the container runtime, named port owners, overlapping port claims, orphaned labeled containers, the volumes `buncargo prune` would reclaim, the tunnel registry, and the named-hosts daemon and service install. If the runtime this project selected is down, doctor starts it the same way `dev` would - Docker Desktop, OrbStack, Colima, or `container system start` - and only reports it when that fails or when running in CI. `doctor --fix` restarts a dead daemon, re-trusts the CA, reinstalls a stale service, remints an expired cert, drops stale routes, and resyncs `/etc/hosts`. The fixes that need a password are skipped without a TTY.

## Programmatic API

A config imports `buncargo`; code that drives an environment imports `buncargo/api`.

`buncargo/api` also exports a type for each document the CLI prints with `--json`, so a script can type what it parses: `DetachedResultJson` (`dev --detach --json`), `RunsJson`, `StatusJson`, `EnvJson`, `SecretsCheckJson` (`secrets check --json`), `FilesStatusJson` and `CheckPlanJson` (`check --list --json`).

```typescript
import { loadDevEnv } from "buncargo/api";
import type devConfig from "./dev.config";

const env = await loadDevEnv<typeof devConfig>();
console.log(env.ports.postgres, env.portOffset, env.portOffsetProvenance);
await env.start({ onlyApps: ["api"], autoStartDocker: false });
const webEnv = env.buildAppEnvVars("web");
await env.stop();
```

`start()` prepares the selected services and spawns, supervises and health-checks the selected apps, but it is not `buncargo dev`, and leaves out what the CLI adds around a run. It takes the same [`exclusive` leases](#exclusive-leases) as `dev`, but cannot ask or take one over: a lease another run holds leaves an `essential: false` app out, with a warning, and makes `start()` throw for an essential one. It does not activate named hosts, so `env.urls` stay `http://localhost:<port>`. It runs neither the fast `checks` nor integration `preflight` steps such as the Shopify login, and it does not share apps and services with [remote recipients](#remote-services) (`BUNCARGO_CONNECT_TOKENS`). It records its apps and services in the run registry as `dev` does, so `buncargo ls`, `stop` and BuncargoBar show and stop them, and the entry goes when `stop()` stops the apps or the process exits; `restart`, `send` and `logs` reach only a `buncargo dev` run, because nothing in a script answers them and it writes no per-run logs. An app that never becomes ready fails the whole `start()` rather than being parked, and tunnels open only when you call `openPublicTunnels()`. Use `buncargo dev`, or `runCli` from a script, when you need any of these.

`env.buildEnvFingerprint("web")` is a digest of `buildAppEnvVars("web")` that is the same in every checkout and on every machine: it leaves out ports, IP addresses, the project name, the workspace id and the checkout root. Key a build cache on it to share one build between worktrees or CI runners. It is only correct when the build bakes in none of those values, so leave a URL with a port out of the build's env first.

`loadDevEnv()` imports the config at runtime, so pass your config type (`loadDevEnv<typeof devConfig>()`) to keep the `defineDevConfig` inference - `ports`, `urls`, `getEnvVar`, and `buildAppEnvVars` stay keyed to your actual services and apps. Without it you get the widened `AnyDevEnvironment` shape, where those keys are plain strings.

Repeated `loadDevEnv({ cwd })` calls keep the same environment object by default. For separate runs in one process, use `fresh: true`: the config module stays cached while ports, URLs, captures, owned processes, and the session ID belong to the new environment. Keep the returned reference for each project. `reload: true` re-imports the config entry, while its imported dependencies remain cached. Sessions share this checkout's service stack and allocation; use `withSuffix()` when you need isolated container stacks.

One environment rejects overlapping `start()`/`startServers()` calls and starts attempted during teardown; independent sessions may start concurrently. Calling `stop()` during startup cancels that startup and waits for its child cleanup before teardown. Stop requests run in order, so a later `stop({ removeVolumes: true })` retains its stronger teardown. Await `stop()` before reusing the environment.

Run `bun run test:stress-sessions` to exercise 200 sessions across four projects in one process. It checks live HTTP apps, workers, startup and ready-session cancellation, process and signal-listener cleanup, file descriptors, worker locks, registry claims, and bounded memory growth after warmup. `--sessions=1000 --concurrency=8` increases the workload; `--max-heap-growth-mib` and `--max-rss-growth-mib` set memory ceilings. The harness isolates its home directory and container binaries, and CI runs it on macOS and Linux.

```ts
import { loadDevEnv } from "buncargo/api";
import type config from "./dev.config";

const web = await loadDevEnv<typeof config>({ cwd: process.cwd(), fresh: true });
const api = await loadDevEnv<typeof config>({ cwd: process.cwd(), fresh: true });
const lifetime = new AbortController();
try {
  await Promise.all([
    web.start({ onlyApps: ["web"], productionBuild: false, signal: lifetime.signal }),
    api.start({ onlyApps: ["api"], productionBuild: false, signal: lifetime.signal }),
  ]);
} finally {
  lifetime.abort();
  // releaseRun leaves shared containers available to other sessions.
  // stop() explicitly tears down the shared stack; use it for that intent.
  await Promise.all([web.releaseRun(), api.releaseRun()]);
}
```

`releaseRun()` releases container ownership; it does not stop supervised app processes. For a script that starts servers, retain its cancellation signal or stop its returned process IDs when the script's work finishes.

A complete example that awaits app cleanup is in `example/library-sessions`: run `bun example/library-sessions/run.ts` from this repository.



`createDevEnvironment(config)` constructs the same environment directly and infers from the supplied config. Construction reads persisted ports or computes a cold preview without runtime probes. Startup finalizes allocation and updates the ports/URLs objects in place; re-read them after startup instead of holding copied preview values.

Use `env.exec(["bun", "scripts/maintenance.ts"], { app: "api" })` to run a command without starting the lifecycle.
