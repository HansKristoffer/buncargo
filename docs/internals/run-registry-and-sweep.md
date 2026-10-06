# Run registry, sweep and BuncargoBar

User-facing summary: [runtime maintenance](../runtime-maintenance.md).

## One liveness record

There is **one** liveness record: `~/.buncargo/runs.json` (`src/core/run-registry.ts`). It holds
per-session identity, process birth identity, the selected services, runtime, binary and aliases,
and owned versus reused apps. Several sessions in one root coexist. Updates are serialized and
terminal states cannot regress to ready. Read-only consumers filter live entries without writing;
writers prune. `stop --run` selects an exact session.

- `environment/run-claim.ts` publishes a run's entry *before* its first container exists, so the
  sweep can never see a fresh stack as unowned. The entry carries the idle hold, the runtime and
  the pinned binary, which is why the sweep needs no config. The library claims too, not only the
  CLI, and `start()` ensures the watchdog right after claiming (`StartOptions.watchdog: false` opts
  out, for tests; the claim happens either way).
- Releasing sets `releasedAt` once (the first release wins, however many teardown paths reach it)
  and keeps the entry; a run with no services is withdrawn instead. An explicit `stop()` *retires*
  instead of releasing, because it has just torn the containers down: its own session and any
  finished session for the same checkout go.
- Every write addresses an entry by `sessionId`, which is required; entries without one are dropped
  on read.
- A library run with no hold asked for through `claimRun` keeps its containers after it exits.
  `options.autoShutdown` is the CLI's, applied only on top of the default the CLI passes: a script
  that brings a stack up and ends is indistinguishable from a crash, and "no hold" means "as long
  as the checkout" however the run ended. The CLI passes its three-minute default explicitly.

## Process identity

Liveness is forgiving where signalling is strict. `processIdentityMatcher`/`runLiveness` read a
process whose identity cannot be read as *alive*, because reading a live run as dead lets the sweep
tear its containers down. `matchesProcessIdentity` (used by `stop` before it signals, and by worker
ownership) reads the same as *not a match*.

The batch asks `ps` only about pids that exist and reads its output whatever the exit status: one
pid `ps` rejected used to void the whole batch. Identities are compared across processes, so they
must not depend on the reader's environment. On macOS `ps -o lstart` follows the caller's locale
and time zone, and a run started from a Danish-locale terminal and a watchdog started from a
`C.UTF-8` agent shell disagreed about the same live pid. `ps` is always asked in `LC_ALL=C`,
`TZ=UTC`; identities carry a `v2:` prefix.

## Writers

`src/cli/run-publish.ts` is the CLI's writer of the run registry; `environment/run-claim.ts` is the
library's. Both build their entry with `buildRunEntry`, so identity, worktree and the recorded CLI
cannot drift between them (the recorded CLI is exactly where they once did).

- The CLI publishes onto the session the environment already claimed (`env.sessionId`), and
  `publishRun` keeps that claim's `startedAt` and idle hold. It takes a structural `RunSource`
  rather than `DevEnvironment` because that type's app keys appear in both parameter and return
  positions, so a widened version is not a supertype of a specific one.
- Every function swallows its own failures: a run that started servers but could not write a
  status file is still a working dev environment.
- `runDevFlow` publishes *after* the takeover is decided, since before that the classification
  describes a reuse the takeover is about to undo and `env.urls` may still hold the localhost
  fallback.
- `recordAppSpawn` stores a spawned app's process identity with its pid, because `stop` refuses to
  signal an app without one; recording the pid alone made the menu bar's Stop refuse every app.
- `core/cli-entry.ts` records buncargo's own CLI (`src/cli/bin.ts` or `dist/cli/bin.js`, whichever
  flavor is running) as the command the menu bar calls back. `process.argv[1]` is the user's script
  under a library `start()` or a wrapped `runCli`, and Stop used to run it.
- `src/core/app-url.ts` is the "open" rule (`preferredAppUrl`): public URL, else the named host
  while hosts are active, else loopback. The registry records it per app as `openUrl`, and
  BuncargoBar prefers that field over its own fallback rule.

## Stop

`src/cli/commands/stop.ts` is what the menu bar app shells out to, so it reads only the registry:
no config load, no Docker unless a service is the target.

- Stopping one app must not end the run, which is why `isDeliberateExit` in
  `process/dev-servers.ts` treats a signalled exit (and `130`/`143`, what a shell wrapper reports
  for SIGINT/SIGTERM) as a clean stop rather than a failure.
- The two refusals (the attached app, and an app reused from another terminal) carry exit code 3;
  `2` is "no such target".
- Services are `stop`ped, never `kill`ed, so a `restart:` policy cannot undo it; the exited
  container is removed by the sweep once the run has ended. Stopping the whole run `down`s its
  containers, because the run itself only releases them to the idle hold and "stop" from the menu
  bar means now.

## The sweep

`src/container-runtime/sweep.ts` is the one cleanup policy.

- `decideSweep` is pure: a stack nobody owns comes down when its checkout is gone, when every
  container is stopped, when its run released it longer ago than its idle hold, or when its owner
  has been gone for longer than the grace. A running stack with no entry at all is left alone.
- The grace counts from `ownerLostAt`, which the sweep stamps the first time it finds an unreleased
  owner gone, not from `updatedAt`, which a quiet run may not have written for hours before it
  crashed.
- `sweepOrphanedContainers` lists every runtime without probing first (a failed `list()` is the
  probe, and records which runtimes *answered*), reads liveness once for the whole registry,
  decides each stack under its project's lifecycle lock (`project-lock.ts`; a busy lock is
  skipped, not failed), then retires entries whose containers are gone. Only when the runtime that
  held them answered: an empty listing from a daemon that is down means "cannot tell".
- It throws when the registry cannot be read, before touching anything: with no registry every
  stack looks unowned. It returns what it listed, so `ls` and `doctor` do not list again.
- A stack condemned from the sweep's snapshot is decided again from a fresh registry read under its
  lock, because a new run publishes its claim before it takes the lock to reuse those containers.
- `ContainerDownRequest.model` is optional because containers are found by label. Only
  `removeVolumes` needs it, to name the volumes, which is why the sweep can tear a project down
  without loading its config. For the same reason the Docker backend passes `-f` only when the
  compose file still exists and never requires the checkout as `cwd`: a stack whose worktree was
  deleted must still come down, and that used to be the one case the watchdog could not handle.

**Anything that runs the sweep outside a unit test's stub runtimes must isolate the container
runtime as well as `HOME`**: stub adapters, or `DOCKER_HOST` pointed at nothing. Isolating only the
registry makes every real stack on the machine look unowned. Docker Desktop finds its Compose plugin
through `HOME`, so a stray isolated `HOME` fails every teardown, which is luck, not safety;
`stopContainers` names that failure (`'compose' is not a docker command`) rather than passing it
through. `bunfig.toml` preloads `scripts/test-runtime-isolation.ts`, which puts failing `docker`
and `container` stubs first on `PATH` for every unit test.

## The watchdog

The watchdog (`core/watchdog-runner.ts`, one per machine, started by `ensureWatchdog`) runs the
sweep through `core/watchdog-loop.ts`, which logs and retries a pass that throws instead of exiting,
and logs a repeated failure once until it changes. `ls` and `doctor` sweep inline, so a killed
watchdog is never the last line of defence.

`core/watchdog.ts` is just `ensureWatchdog` and its pid file. Two locks, and it needs both: the
runner holds `.runner` for its whole life, which is the "is one running?" answer a `kill -9` cannot
fake, and a caller holds `.spawn` across spawn-and-confirm so two `dev` runs starting together
cannot each launch one. Collapsing them looks tempting and deadlocks: the spawner would be holding
the lock its own child must take.

## Volumes

`prune.ts` is the volume half, and it is deliberately not automatic: a container costs nothing to
recreate, a volume is the database. `planVolumePrune` is pure and proposes only a volume whose
Compose project has no containers *and* no entry; `cli/commands/prune.ts` confirms before removing.

Buncargo attaches **no labels to volumes**. Verified: Compose compares a volume against the file
and prompts "exists but doesn't match configuration in compose file. Recreate (data will be
lost)?", which hangs a non-interactive run. So a volume's checkout is unknowable, anonymous
(64-hex) Docker volumes are filtered out as never ours, and anything unattributable is counted and
left alone rather than guessed at.

`prune --project` (`project-prune.ts`) can say more, because the config and Git are in hand: the
project's stacks are exactly the names `checkoutProjectNames` gives each checkout in `.git`'s
worktree list, deleted ones included, under current and pre-12 naming. Never a prefix match: a
renamed worktree's dev stack can read `<prefix>-<dir>-ci-<name>`, and another project can share the
prefix. It is a flag rather than the default inside a checkout so plain `prune` keeps meaning the
same thing everywhere, and it does not sweep first, since the sweep reaches every project.

- A container keeps its whole stack unless its `buncargo.root` is, as recorded, the root of the
  checkout the stack's name belongs to. Not resolved through links: a library run rooted at a
  symlink `main-ci` to `main` names its dev stack after the link, which reads as `main`'s ci stack.
- A root below the repository's top level gets no worktree name, because `getWorktreeName` reads
  the root's own `.git` file. Its checkouts then share one dev and one ci name, and the dev name is
  kept while any of them exists.
- An inventory that fails aborts rather than reading as empty. Each stack is decided again under
  its lifecycle lock from fresh Git, runtime and registry inventories, and only what was listed is
  removed; a refused container keeps the rest of its stack.
- Docker-only, through two optional adapter methods: Apple records no Compose project on volumes.

## BuncargoBar

`menubar/` is the macOS menu bar app (Swift 6 / SwiftUI `MenuBarExtra`, SwiftPM, no Xcode project).
It is not shipped in the npm package and not built by `bun run build`; it releases on its own
`bar-v*` tags.

- It is a **reader**. It decodes `~/.buncargo/runs.json` and shells every mutation out to
  `buncargo stop`, using the interpreter recorded in the entry so a worktree on a different version
  stops with its own build. It never signals a process or talks to Docker itself.
- `menubar/fixtures/runs.v1.json` is the schema contract. `menubar/scripts/smoke-test.sh` runs the
  app's `--status` mode against it and `src/core/run-registry.fixture.test.ts` decodes the same
  file, so a field one side drops fails a test on both.
- `RunRegistry.stateDirectory` reads `HOME` before `homeDirectoryForCurrentUser`, which ignores the
  environment. Without that the smoke test is silently handed the developer's real registry.
- `src/core/menubar.ts` is the app from the CLI side: detection, GitHub release download with
  checksum verification, install, update, uninstall. The CLI is the only updater
  ([bar updates](../bar-updates.md)); the app has no checker, so two updaters never race on one
  bundle. `fetchLatestBarRelease` filters the releases list by the `bar-v` tag prefix rather than
  using `releases/latest`, which would return whichever tag was published most recently, usually a
  CLI one.
