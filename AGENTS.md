# Buncargo

`buncargo` is a Bun-first library and CLI for local development environments. One `dev.config.ts`
describes a project's services (containers) and apps (dev servers); buncargo gives every checkout
its own ports, containers, URLs and named `https://*.localhost` hosts, starts and supervises
everything, and cleans up after runs that ended. BuncargoBar (`menubar/`) is a macOS menu bar app
that shows the runs.

It is used only by our own projects, mostly from many Git worktrees at once, and most changes to it
are made by agents working in one of those worktrees.

## What we never compromise on

1. **Every checkout is isolated.** Two worktrees of one project run side by side with no shared
   port, container, database, hostname or state file. A change that works in the main checkout and
   collides in a worktree is broken.
2. **Data survives.** A container is cheap to recreate; a volume is a developer's database.
   Nothing removes a volume without an explicit, confirmed command, and one run ending never takes
   down another run's services.
3. **Startup is fast.** It is paid on every run in every worktree. Count the processes a change
   forks before anything starts, and measure with `buncargo dev --timing`.
4. **Named hosts are reliable.** Their failure mode is silent: the run falls back to
   `localhost:port` with no error. Treat "sometimes does not attach" as a bug, not flakiness.
5. **Agents can drive it.** Every flow works without a terminal: `--detach`, `--yes`, `--json`,
   exit codes that mean one thing. `src/cli/agents-guide.ts` (`buncargo help agents`) is what
   agents in *our projects* read; keep it true when behavior changes.

Think of everything below as good defaults. If a rule here fights the task in front of you, say so
loudly and get a human sign-off before breaking it.

## Words

Use these the same way in code, comments and PRs. Full table: `docs/internals/glossary.md`.

- **checkout** (or root): one directory with a `dev.config.ts`, the main clone or a worktree. The
  unit of isolation.
- **run**: one `buncargo dev` or library `start()`. Its **session** is its entry in
  `~/.buncargo/runs.json`.
- **claim** a run before its first container exists. **Release** it when it ends on purpose: the
  containers wait out the **idle hold** for the next run. **Stop** means tear down now. **Retire**
  means remove the entry because nothing is left to hold.
- **service**: a container. **App**: a supervised process. **Stack**: containers another CLI runs
  for an integration. **Worker**: an app with no endpoint.
- **sweep**: the one cleanup policy, run by the per-machine **watchdog** and by `ls`/`doctor`.
- **surface**: a place one behavior must exist (see below).

## The ways to hurt yourself

This machine runs the developer's real dev environments while you work, including other
worktrees of this repo and of the projects that use it.

1. **The sweep against real Docker.** Anything that runs the sweep, the watchdog or
   `dev --down --all` with an isolated `HOME` but a reachable container runtime sees every real
   stack on the machine as unowned and tears it down. Isolate both: stub the adapters, or point
   `DOCKER_HOST` at nothing. `bun test` already stubs `docker` and `container`
   (`scripts/test-runtime-isolation.ts`); scripts and manual runs do not.
2. **Volumes.** Leave volumes unlabelled and unremoved. Labelling a Compose volume makes Compose
   prompt "Recreate (data will be lost)?" and hangs every non-interactive run. Only
   `buncargo prune`, after confirmation, removes one.
3. **Killing by pattern.** Stop only what you started, by the pid you captured or through
   `buncargo stop`. Never `pkill -f`, `killall`, or `docker rm` by name: other worktrees' runs and
   your own agent share these names and paths.
4. **The developer's machine state.** `~/.buncargo`, `/etc/hosts`, the root hosts daemon and its
   certificates are live. In tests, point `HOME` at a temporary directory and inject the seams the
   modules take (`privileged`, the reloader's edges, `copy`). Never run `sudo`, and never
   `dev --reset` or `dev --down --all` to "fix" something.

## Hit every surface

The most common defect here is a change that works on the path you tested and is missing on the
others. Before calling work done, walk this list and say which entries applied:

- **CLI and library.** `runDevFlow` (`src/cli/run-cli.ts`) and `start()` (`src/environment/`) are
  two entry points to one behavior. Claims, seeding, server hooks, secrets and readiness must
  match on both.
- **Runtimes.** Docker (`src/docker/`) and Apple `container` (`src/apple-container/`) sit behind
  `ContainerRuntimeAdapter`. A container behavior needs a decision per backend, even if it is "not
  supported here".
- **Output modes.** Stream mode and the TUI both render app output, answer `restart` and `send`,
  and write the per-run logs.
- **Run registry readers.** `runs.json` is read by `stop`, `ls`, `status`, the sweep, `dev --detach`
  and BuncargoBar. A field change updates `menubar/fixtures/runs.v1.json`, which both sides test
  against.
- **Machine-readable output.** `--json`, exit codes and `buncargo help agents` are contracts agents
  depend on.
- **Reverse states.** A way in needs a way out and a way to see it: claim/release/stop,
  setup/uninstall, takeover/reuse. A one-way door is a bug.
- **Integrations.** Expo, Shopify and Supabase reach core only through `BuncargoIntegration`
  hooks. A core change that assumes one of them goes through those hooks instead.
- **Docs.** `readme.md` and `docs/reference.md` for usage, `docs/migration.md` for a breaking
  change, and the [documentation rules](#documentation) for anything else.

## Before you change a subsystem

Read the matching internal note first. Each one records the constraints and the incidents behind
them that the code alone does not explain.

- Run lifecycle, `runs.json`, `stop`, the sweep, watchdog, volumes, BuncargoBar:
  `docs/internals/run-registry-and-sweep.md`
- `src/core/hosts/`, certificates, the proxy, `/etc/hosts`: `docs/internals/named-hosts.md`
- Compose generation, `src/container-runtime/`, either backend: `docs/internals/container-runtimes.md`
- Port allocation, offsets, port owners: `docs/internals/ports.md`
- Spawning, waves, restarts, `essential`, workers, leases: `docs/internals/process-supervision.md`
- The TUI, pseudo-terminals, app output and logs: `docs/internals/tui.md`
- `src/environment/`, seeding, captures, Prisma: `docs/internals/environment.md`
- CLI commands, flags, takeover, detach, typecheck: `docs/internals/cli.md`
- Infisical secrets: `docs/internals/secrets.md`
- Expo, Shopify, Supabase, stacks: `docs/internals/integrations.md`
- State paths, file locks, persisted files, `runtime-flags.ts`, prompts: `docs/internals/core.md`
- frp sharing: `docs/internals/connect.md`

How a run fits together, and the startup invariants: `docs/internals/overview.md`.

## Working in this repo

- `bun install` installs. Worktrees need it before anything resolves.
- `example/playground` is a runnable project (Postgres, a Bun API, Vite) for trying the CLI end to
  end; run the CLI from source there with `bun ../../src/cli/bin.ts dev --detach`. The
  `verify-buncargo` skill (`.agents/skills/verify-buncargo/SKILL.md`) is the full procedure. That
  run is real: it claims ports, containers and hostnames on the developer's machine, so stop it
  with `buncargo stop --all` when you are done.
- Prefer a hermetic test over a real run. Reach for the playground when the change is about what a
  real process, container or terminal does.

## Verifying

- While iterating, run the tests you touched: `bun test <files>`.
- Before finishing a substantive change, run all three: `bun run build`, `bun run lint:write`
  (typecheck, then Biome) and `bun test`. Leave the repo with all three passing.
- Behavior changes ship with tests for that behavior, co-located as `*.test.ts`. Test what a
  module observably does, not how it is wired.
- A test that needs a sleep to pass is wrong. Await the event, poll a condition against a deadline,
  or inject the clock.
- Rules with a history of being broken are enforced by `src/architecture.test.ts`. Fix the code
  rather than widening its allow-list.
- Opt-in suites (real tunnels, mkcert, the hosts soak, Apple `container`, frp, the Shopify CLI)
  and when to run them: `docs/testing.md`.

## Compatibility

Breaking changes are hard cutovers in a major release: no aliases for old names, no readers for
old on-disk formats, no deprecation periods. Write what changed in `docs/migration.md` and update
the projects instead. Treat `src/index.ts`, the published subpath exports, CLI behavior and
exported types as high-impact.

## Pull requests and releasing

Releases happen by merging; Release Please reads squash-merged PR titles as conventional commits.
Procedure and recovery: `docs/releasing.md`.

- Never open a PR unless asked.
- Titles are conventional commits with a scope: `fix(hosts): …` releases a patch, `feat(cli): …` a
  minor, `feat(cli)!: …` a major. `chore`, `docs`, `refactor`, `test` and `ci` release nothing. Use
  `bar` as the scope for `menubar/`. A PR touching only `menubar/` bumps BuncargoBar, anything else
  bumps the CLI, and both when it touches both.
- The squash **body** must parse too. Keep PR descriptions plain prose and `-` bullets: a fenced
  code block or a line shaped like `word(scope):` makes the parse throw, and Release Please
  silently cuts no release with CI green. `.github/pull_request_template.md` spells out the
  format.
- `package.json` `version`, `menubar/version.txt` and every `CHANGELOG.md` belong to the release
  PR.

## Documentation

Most changes need no internal documentation change. Agents can read the code.

- A reason that only one function or file needs goes in a short comment there, and moves with the
  code.
- `docs/internals/` is for decisions and their reasons, constraints that span modules, and traps
  that are hard to discover from the source. Before adding a paragraph, ask what a maintainer
  would get wrong without it. When a documented decision changes, rewrite or remove the affected
  text; do not append a second account of the new behavior.
- `readme.md`, `docs/reference.md` and `docs/integrations.md` help users get something done. Keep
  them in the product's voice, free of internals. Update the section whose usage changed.
- This file holds what every task needs. A subsystem's detail belongs in its internal note,
  reached through the list above.

## Plans and scratch work

Keep implementation plans, research notes and scratch files out of the repository; `.plans/` is
gitignored for them. A merged PR is the implementation record.

## Where code lives

All library source is under `src/`; tests sit beside the module they test.

- `index.ts`: the public API. New public exports are added here on purpose.
- `cli/`: the CLI. `bin.ts` is the executable, `run-cli.ts` the dev flow, `commands/` one module
  per command, `tui/` the TUI.
- `config/`: `defineDevConfig`, validation and integration application. Definition, validation and
  merging stay in separate modules.
- `environment/`: `createDevEnvironment()`, composed from focused modules built on `context.ts`.
- `docker-compose/`: Compose model generation and the service presets. No runtime calls.
- `container-runtime/`: the runtime-neutral adapter port, readiness, inventory, the sweep and
  volume pruning. Everything outside the backends imports runtimes from here.
- `docker/`, `apple-container/`: the two backends.
- `core/`: shared runtime: `process/`, `hosts/`, `secrets/`, `connect/`, the run registry, port
  allocation, locks and state files.
- `loader/`: config discovery and loading. `typecheck/`: the workspace typecheck pool. `prisma/`:
  Prisma integration. `types/`: the type surface (`all-types.ts`, `index.ts`).
- `expo/`, `shopify/`, `supabase/`: integrations, published as subpaths.
- `vite/`, `client/`, `runtime/`: small entry points loaded inside users' apps; keep their import
  graphs tiny.
- `menubar/` (Swift), `server/` (the connect relay), `example/` (configs and the playground),
  `scripts/` (CI, benchmarks, package verification).

Import a directory through its `index.ts` (`./config/index`, `./environment/index`); do not add
thin top-level files that only re-export another module.

## Taste

- Small, pure functions with I/O at explicit boundaries. Pure decisions (`decideSweep`,
  `run-plan.ts`, `render.ts`) carry most of the tests.
- One owner per concern: `runtime-flags.ts` reads environment flags, `docker/binary.ts` spells
  `docker`, `prompt.ts` asks questions, `child-env.ts` builds child environments, `state-paths.ts`
  places state. Use the existing owner before writing a second one.
- Persisted files are written through a temp file and a rename, and shared read-modify-writes go
  through `withFileLock`.
- Separate setup, validation, side effects and cleanup with blank lines. Comments explain intent,
  constraints and phase transitions, never every line.
- Error messages say what to do next, and name the checkout, port or process involved.
- Strict TypeScript. Prefer inferred types; `any` is the enemy. A `switch` over a closed union ends
  in a `never` default.
