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

Liveness is forgiving where signalling is strict. `processIdentityMatcherAsync`/`runLivenessAsync` read a
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

`environment/run-claim.ts` writes the claim; `core/run-publish.ts` writes the entry with its
apps, for `runDevFlow` and for a library `start()`/`startServers()` that spawns apps (through the
claim's `claimApps`, with the environment as its `RunSource`). Both build their entry with
`buildRunEntry`, so identity, worktree and the recorded CLI cannot drift between them (the
recorded CLI is exactly where they once did), and a script's apps get the same rows as `dev`'s.

- Both publish onto the session the environment already claimed (`env.sessionId`), and
  `publishRun` keeps that claim's `startedAt` and idle hold. An app-only run has no claim, so its
  first entry is this one; it is withdrawn when its apps stop (`stop()`), when the start that
  listed them fails, or by the next writer's prune once its process is gone. It takes a structural `RunSource`
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
  `process/process-owner.ts` treats a signalled exit (and `130`/`143`, what a shell wrapper reports
  for SIGINT/SIGTERM) as a clean stop rather than a failure.
- The two refusals (the attached app, and an app reused from another terminal) carry exit code 3;
  `2` is "no such target".
- Services are `stop`ped, never `kill`ed, so a `restart:` policy cannot undo it; the exited
  container is removed by the sweep once the run has ended. Stopping the whole run `down`s its
  containers, because the run itself only releases them to the idle hold and "stop" from the menu
  bar means now. It downs only on the runtimes the entry records: probing every runtime for an
  app-only run's project once took down a stack another run held. Then it retires the entry, and
  the project's finished entries whose containers all came down with it.
- `stop --all` also takes down what a checkout's finished runs left (released into the hold, or
  crashed inside the grace), without asking, since nothing of theirs runs. A live run of the same
  project keeps them, and a live run the person declined to stop keeps the whole checkout's.

## The sweep

`src/container-runtime/sweep.ts` is the one cleanup policy.

- `decideSweep` is pure: a stack nobody owns comes down when its checkout is gone, when every
  container is stopped, when its run released it longer ago than its idle hold, or when its owner
  has been gone for longer than the grace. A live owner keeps its stack before the checkout is
  even looked at. A running stack with only a claim is left alone.
- Only a stack this `HOME`'s state names is a candidate (`isKnownStack`): a `runs.json` entry
  (any session, live or not) or an `offsets.json` claim with its project and root. Several users
  can share one daemon, and from another account a live run's stack has no entry and a checkout
  under an unreadable home. Anything else is `foreign`: reported by `ls` and `doctor` with
  `manualDownCommand`, never touched. `dev --down --all` (`stop-all.ts`) follows the same rule.
  So a claim must outlive its stack: `settleDeletedCheckouts` keeps a deleted checkout's claim
  while a stack of its project and root is still listed (a failed `down`, a busy lock) or while
  no runtime answers, or that stack would be nobody's to remove.
- "Checkout gone" means confirmed missing: `checkoutPresence` (`core/checkout-presence.ts`) says
  `deleted` only on `ENOENT` or `ENOTDIR`. Any other error, typically `EACCES` on another user's
  home, is `unknown` and counts as present wherever a root decides what to remove or forget: the
  sweep, settling claims, `readOffsetClaims`, prune's existing checkouts, host routes and
  certificate names. `existsSync` reads `EACCES` as missing, and a watchdog running as one user took every
  checkout of the CI user's home for deleted and tore its stacks down, a live E2E run's included.
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

### The removal log

A container cannot be relabelled after it exists, and a removed one carries nothing, so who removed
a stack is recorded on our side: `core/removal-log.ts`, `~/.buncargo/removals.json`, the newest 500
records, rewritten whole under its file lock. The sweep records at each `result.swept` push, with
the run the verdict was decided against; `stop`, `dev --down --all` and the library's `stop()`
record their own teardowns. Recording never throws: a removal that happened must not read as
failed.

It is read only on failure paths, never before startup: `explainMissingContainers` lists the
runtime's containers, and only when a selected one is missing reads the log for a record of the
project and root since the run's claim. The incident behind it: a CI job saw `ECONNREFUSED` and
then Compose's "No resource found to remove", and the cause, another user's watchdog, was only in
that user's `watchdog.log`. The log is per user like the rest of `~/.buncargo`, which is why "no
record" points at other users' logs and `docker events` instead of guessing.

**Anything that runs the sweep outside a unit test's stub runtimes must isolate the container
runtime as well as `HOME`**: stub adapters, or `DOCKER_HOST` pointed at nothing. Isolating only the
registry makes every real stack on the machine look unowned. Docker Desktop finds its Compose plugin
through `HOME`, so a stray isolated `HOME` fails every teardown, which is luck, not safety;
`stopContainers` names that failure (`'compose' is not a docker command`) rather than passing it
through. For every unit test, `bunfig.toml` preloads `scripts/test-runtime-isolation.ts`, which
does both: failing `docker` and `container` stubs first on `PATH` and a dead `DOCKER_HOST`, and a
temporary `HOME` for the run.

## The watchdog

The watchdog (`core/watchdog-runner.ts`, one per machine, started by `ensureWatchdog`) runs the
sweep through `core/watchdog-loop.ts`, which logs and retries a pass that throws instead of exiting,
and logs a repeated failure once until it changes. `ls` and `doctor` sweep inline, so a killed
watchdog is never the last line of defence. Each pass first takes out the Tailscale Serve entries
of runs that have ended ([named hosts](./named-hosts.md#tailscale-mode)); with none, that is one
file read. It does not keep the watchdog up: an entry whose removal failed waits for the next
`ls`, `doctor` or tailscale-mode activation.

It also serves the live entries, as a `runs.json` document, on the machine's Tailscale address
(`core/tailnet-directory.ts`) to BuncargoBar on the other machines of the tailnet. That bar may be
a different version than the CLI it reads, so the registry's old-reader compatibility now holds
across machines too. So a run without containers ensures the watchdog as well, once its apps
are up and not awaited, so nothing is added before they start: `runDevFlow` from `onReady`, and
`start()` after its apps are ready unless `watchdog: false`. `startServers()` takes no options to
opt out with, so it ensures none. The loop already stays while any entry is live, containers or
not, and stays for no container of a stack the sweep reports as another user's
(`watchesNothing`): on a daemon shared with a CI user, those would keep it up for good. It also
exits once its state directory is confirmed gone, which is a test's temporary `HOME` deleted
under it, or once the process `BUNCARGO_WATCHDOG_PARENT` names has ended, which the test preload
sets to the `bun test` process: two runners started by a test outlived it, found the real `docker`
and, with no registry of theirs naming a stack, swept another user's. A real watchdog never gets
the variable, because it has to outlive the run that started it.

One watchdog sweeps for every checkout, so whichever buncargo started it decides for all of them: a
12.4 runner started from one worktree swept stacks of worktrees on 13. The runner records its
version in the pid file, and `ensureWatchdog` replaces a runner whose version is strictly older, or
missing (written before versions were recorded). It sends SIGTERM only after a strict identity
match, never to a pid file without an identity and never to itself (`watchdog.testing.ts`'s
stand-in is the test process), then waits for `.runner` with a bounded timeout and spawns as usual.
Strictly older only, so two current versions never take turns, and an older CLI, which knows
nothing of versions, leaves a newer runner alone. It runs inside the `.spawn` hold, which is safe:
the old runner exits on SIGTERM without taking `.spawn`, and one already waiting for `.spawn` in
`exitUnlessClaimed` is killed while it waits. A stand-in pid file must record the current version,
or the first CLI it serves replaces it.

On Linux the watchdog, like `dev --detach` and the sharing coordinator, starts in a systemd
user scope of its own when there is a user manager (`process/user-scope.ts`; off with
`BUNCARGO_SYSTEMD_SCOPE=0`). A detached child is still in its parent's cgroup, and an agent harness
running as a `systemctl --user` service (`KillMode=mixed`) kills that whole cgroup on restart.
`systemd-run --scope` execs in place, so the pid the pid file and the registry match is unchanged.

`core/watchdog.ts` is just `ensureWatchdog` and its pid file. Two locks, and it needs both: the
runner holds `.runner` for its whole life, which is the "is one running?" answer a `kill -9` cannot
fake, and a caller holds `.spawn` across spawn-and-confirm so two `dev` runs starting together
cannot each launch one. Collapsing them looks tempting and deadlocks: the spawner would be holding
the lock its own child must take.

The runner takes `.spawn` too, once, to exit (`exitUnlessClaimed` in `watchdog-loop.ts`). A pass
that finds nothing to watch read the registry before a run that claims after it, and that run's
`ensureWatchdog` sees this runner and starts none. So the runner removes its pid file under
`.spawn`, reads the registry again, and either restores the file and keeps watching or exits still
holding `.spawn`, releasing it only after `.runner`. It stays for a live run, and for any session
the pass did not see: one that claimed after the pass and already released or crashed is no longer
live, but its containers are still to be swept (`claimedSincePass`). It never waits on `.spawn` at start, and a
spawner holding `.spawn` only try-acquires `.runner`, so neither waits on the other.

## Volumes

`prune.ts` is the volume half, and it is deliberately not automatic: a container costs nothing to
recreate, a volume is the database. `planVolumePrune` is pure and proposes only a volume whose
Compose project has no containers, no entry *and* no existing checkout; `cli/commands/prune.ts`
confirms before removing. The checkouts come from the dev port claims in `offsets.json`, because
an idle checkout after `dev --down` has neither containers nor an entry, and its volume is still its
database. Suffixed claims (`ci`, E2E) do not count: their stacks are leftovers once the run is gone.

Buncargo attaches **no labels to volumes**. Verified: Compose compares a volume against the file
and prompts "exists but doesn't match configuration in compose file. Recreate (data will be
lost)?", which hangs a non-interactive run. So a volume's checkout is unknowable, anonymous
(64-hex) Docker volumes are filtered out as never ours, and anything unattributable is counted and
left alone rather than guessed at.

One exception, opt-in per machine: with `BUNCARGO_PRUNE_DELETED_CHECKOUTS=1` the sweep also
removes a deleted checkout's volumes (`settleDeletedCheckouts`), for servers where agents create
and delete worktrees by the hundred. It works from the port claims in `offsets.json`, not from
container stacks: a checkout's claim names its root and project, and by the time a worktree is
deleted its containers are usually long gone, so a stack-driven rule would never see it. The sweep
keeps a deleted checkout's claim until it has settled it, and without the opt-in only drops it.
Volumes match by Compose project, and two checkouts can share one, so it removes them only when
no existing checkout claims the project and no run on record for it still has its checkout; a
container of the project still standing defers the decision to the next pass, and a runtime that
does not answer defers everything. "Still has its checkout" includes one this user cannot read.

The watchdog also reports, at most hourly and only when the set changes, the volumes `prune` would propose (`orphan-report.ts`). It never removes them: a project with no port claim has no removal record, so the sweep never sees it, and a report is the only thing that can say so. Only runtimes that answered that pass are judged, each against its own containers. The one automatic volume removal that is not an opt-in is `buncargo ci`'s own leftovers (`ciLeftoverVolumes`): at its start it removes what a killed run left in its `-ci` project, only when no container or run names that project, as its teardown would have done.

Volumes need more proof than containers. A deletion counts only when confirmed (`ENOENT`) on two
passes at least `DELETED_CHECKOUT_SETTLE_MS` (10 minutes) apart: the first sighting is stamped on
the claim as `deletedSeenAt` under the claims lock, and cleared if the checkout is back, so an
unmounted disk or a worktree being recreated costs nothing. Containers still come down on the
first confirmed sighting. The watchdog may exit in between; the next pass, whenever it runs,
decides.

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
