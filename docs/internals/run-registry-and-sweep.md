# Run registry, sweep and BuncargoBar

User-facing summary: [runtime maintenance](../runtime-maintenance.md).

## One liveness record

There is **one** liveness record: `~/.buncargo/runs.json` (`src/core/run-registry.ts`). It holds
per-session identity, process birth identity, the selected services, runtime, binary and aliases,
and owned versus reused apps. An app row's `publicUrl` is a tunnel's or one the app printed
(`captures`); `tunnelUrl` marks the tunnel's, and a run reusing that app inherits only it. Several sessions in one root coexist. Updates are serialized and
terminal states cannot regress to ready. Read-only consumers filter live entries without writing;
writers prune. `stop --run` selects an exact session.

A run's state is two values. `lifecycle` is what was recorded: `live`, `released` (the owner exited
on purpose) or `lost` (the sweep found the owner gone), the last two with `at`. `hold` is how long
the containers outlive it: `checkout` (as long as the checkout exists) or `timed` with `ms` and
`inherited`. Every reader turns the lifecycle and its own reading of the owner into one phase with
`runPhase(entry, alive)`, BuncargoBar included (`Run.phase(alive:)`): released is never live, and
lost is live again once the owner reads as itself. Version 1 had two timestamps and two hold
fields the type allowed together, and four readers each defined "finished" their own way; `ls`
showed nothing for a crashed run inside its grace. The schema is one value per entry type
(`core/json-shape.ts`), with the TypeScript type inferred from it, so the guard cannot miss a field
the type has, as v1's missed `hosts`, `worktree`, `branch` and `primaryApp`.

A file an older buncargo wrote reads as empty, strict readers included, and the next write replaces
it, keeping its bytes in `runs.json.recovery-*`. Reading it strictly as unreadable would have
failed every sweep, `ls` and `stop` after an upgrade until some run published.

A publish reads `runs.json` once (`ListRegistry.update`) and prunes under the lock with
`kill(pid, 0)` alone: a start publishes and patches a dozen times, and each publish used to read
the file three times and fork `ps` on macOS. A pid another process reused keeps its entry until the
sweep, which compares identities, finds it gone; the prune never drops an entry that might be live.

- `environment/run-claim.ts` publishes a run's entry *before* its first container exists, so the
  sweep can never see a fresh stack as unowned. The entry carries the idle hold, the runtime and
  the pinned binary, which is why the sweep needs no config. The library claims too, not only the
  CLI, and `start()` ensures the watchdog right after claiming (`StartOptions.watchdog: false` opts
  out, for tests; the claim happens either way).
- Releasing sets `lifecycle` to `released` once (the first release wins, however many teardown paths reach it)
  and keeps the entry; a run with no services is withdrawn instead. An explicit `stop()` *retires*
  instead of releasing, because it has just torn the containers down: its own session goes, and
  so does each finished session of the project whose containers were all on the runtimes it
  downed (`heldOnlyOn`, the rule `stop` applies too). It used to retire every finished session,
  so a library `stop()` on Docker dropped the only record of a stack held on Apple's runtime.
  While another live run of the project uses the services, `stop()` keeps them and releases
  instead (`environment/run-keep.ts`, the rule `stop` applies to a sibling session): two `ci`
  runs once shared one project, and the first to finish removed the other's database mid-test.
- Every write addresses an entry by `sessionId`, which is required; entries without one are dropped
  on read.
- A library run with no hold asked for (`start({ claim })` or `claimRun`) keeps its containers
  after it exits.
  `options.autoShutdown` is the CLI's, applied only on top of the default the CLI passes: a script
  that brings a stack up and ends is indistinguishable from a crash, and "no hold" means "as long
  as the checkout" however the run ended. The CLI passes its three-minute default explicitly.
- Except when that claim reuses a stack another run left in its hold: `holdToInherit` copies the
  newest finished entry's timed hold as `{ kind: "timed", inherited: true }`, and the sweep applies
  it from when the script's run ends, released or found gone. The sweep decides from the newest
  entry only, so a one-second `start()` that reused a released detached run's containers pinned
  them for 13 days. Newest means ended last, by the lifecycle's `at`, then `startedAt`
  (`newestLifecycleFirst`), never `updatedAt`: every patch moves that, and a dead session's
  service watch writing a `problem` made its hold the stack's.
  Finished is `runPhase` with the owner read by `kill(pid, 0)`, as a publish prunes, so the start
  path forks no `ps` for it. An explicit `idleTimeoutMs: false` (`--keep-containers`)
  inherits nothing, and neither does a claim whose newest finished entry kept its containers.

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

- Both publish onto the session the environment already claimed (`env.sessionId`), as two kinds
  of write (`mergePublishedRun`). The claim (`publishRun`) owns the lifecycle: the selected
  services, their stacks (merged by name, so a re-claim selecting none keeps a held one), exactly
  one hold, and reopening a released entry, which takes the new claim's `startedAt`: ranking and
  the claims a teardown releases date from it. The describe
  (`describeRun`) owns what the run serves and keeps everything else: `startedAt`, the hold,
  a release, captures, each app row's process and state, and a service's `problem`; it adds
  services but never removes one. Neither it nor a queued `servicesReady` turns a `stopped`
  service `ready` (`nextServiceStatus`): only a claim, or another `start()` under the claim, which
  marks it `starting` first, brings one back. It used to replace the entry whole, so a library `claimApps`
  reopened a released run, and after `releaseRun()` erased its services record, so the next
  release withdrew the held stack's only owner. An app-only run has no claim, so its
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
- Exit 3 is "refused: leave it running" (the attached app, an app reused from another terminal, a
  run in someone's terminal), and `help agents` tells agents exactly that, so nothing else may
  return it: an unknown flag is `1`, and so is a stop that failed (a teardown the runtime
  refused, a port that would not free), where BuncargoBar's offer of `--force` would not help. `2` is a named target that matches nothing; a bare `stop` with
  nothing running exits 0. A run that ends between the read and the signal is not a refusal
  either: `stop` reads the entry again and, released or gone, takes down what it left.
- Stopping the whole run, or what a finished run left, withdraws the checkout's service routes
  (`withdrawStoppedRoutes` in `sweep.ts`), and so does the sweep's teardown. They carry no pid, so
  nothing else retires them, and a later run that fell back to `localhost:port` still got the
  named URLs from `getEnvVar`.
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
  even looked at: a run between `start()` and `startServers()` is using it. "Stopped" means no
  container keeps the stack up (`keepsUnownedStack` in `container-state.ts`): live in
  `isContainerLive`'s sense, except `restarting`. A crash-looping stack known only by its claim
  has no owner to stop it and serves nothing, and counting it as up kept it for good; an
  `unknown` state still keeps a stack, since misreading a live database is the costly
  mistake. A detached owner of a
  deleted checkout is ended by the watchdog instead ([below](#detached-runs-that-end)), and its
  stack then follows the ordinary rule. A running stack with only a claim is left alone.
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
- The grace counts from a `lost` lifecycle's `at`, which the sweep stamps the first time it finds an
  unreleased owner gone, not from `updatedAt`, which a quiet run may not have written for hours
  before it crashed. The sweep makes it `live` again when the owner reads as itself, and so does
  the owner's own publish: one wrong reading used to stamp a live run for good, and `holdToInherit`
  counted it as finished. When a finished run's containers come down is `holdExpiry`, which
  `decideSweep` and `ls` both read.
- `sweepOrphanedContainers` lists every runtime without probing first (a failed `containers()` is the
  probe, and records which runtimes *answered*), reads liveness once for the whole registry,
  decides each stack under its project's lifecycle lock (`project-lock.ts`; a busy lock is
  skipped, not failed), then retires entries whose containers are gone. Only when the runtime that
  held them answered: an empty listing from a daemon that is down means "cannot tell".
- It throws when the registry cannot be read, before touching anything: with no registry every
  stack looks unowned. It returns what it listed, so `ls` and `doctor` do not list again.
- A stack condemned from the sweep's snapshot is decided again from a fresh registry read under its
  lock, because a new run publishes its claim before it takes the lock to reuse those containers.
- `retireRuns` and `clearRunStacks` take the entries as the pass read them and drop only those
  whose `startedAt` and `lifecycle` are unchanged. A pass retires minutes after its
  read, and by then a library session may have released and claimed again under the same id; by
  session id alone its live entry went. Integration stacks are decided by the checkout's newest
  entry (`runFor`), as containers are.
- `ContainerDownRequest.model` is optional because containers are found by label. Only
  `removeVolumes` needs it, to name the volumes, which is why the sweep can tear a project down
  without loading its config. For the same reason the Docker backend passes `-f` only when the
  compose file still exists and never requires the checkout as `cwd`: a stack whose worktree was
  deleted must still come down, and that used to be the one case the watchdog could not handle.

### The events log

A container cannot be relabelled after it exists, and a removed one carries nothing, so who removed
a stack is recorded on our side: `core/removal-log.ts`, `~/.buncargo/events.json`, the newest 500
events, rewritten whole under its file lock. Each event has a `kind`: `containers`, `volumes`,
`services` (a `buncargo stop <service>`) or `run-stopped` (a detached run the watchdog stopped,
[below](#detached-runs-that-end)). The sweep records at each `result.swept` push, with
the run the verdict was decided against; `stop`, `dev --down --all` and the library's `stop()`
record their own teardowns. Recording never throws: a removal that happened must not read as
failed.

`buncargo stop <service>` records too, with `services`, because a stopped container is
the trace the service watch below looks for. Each actor carries its parent process's name
(`BuncargoBar`, `zsh`): the menu bar shells out to `buncargo stop`, so the command alone
cannot tell its buttons from a terminal.

It is read only on failure paths, never before startup: `explainMissingContainers` lists the
runtime's containers, and only when a selected one is missing reads the log for a record of the
project and root since the run's claim. The incident behind it: a CI job saw `ECONNREFUSED` and
then Compose's "No resource found to remove", and the cause, another user's watchdog, was only in
that user's `watchdog.log`. The log is per user like the rest of `~/.buncargo`, which is why "no
record" points at other users' logs and `docker events` instead of guessing.

### The service watch

A run watches its own service containers (`container-runtime/service-watch.ts`, wired in
`environment/service-watch.ts`): from the moment its services are up until `stop()` or
`releaseRun()`, which end it before anything comes down, so the run's own teardown is never
reported. It polls the runtime's one listing (`containers()`) every 10 s. Both backends throw when the runtime does not answer, and a poll that throws changes
nothing; so an answered empty listing means the project has no containers, and every watched
service is reported removed. A state the runtime reports as `unknown` leaves what was last
reported standing. A service that stops, disappears or turns unhealthy gets a line in the run's
output and `buncargo.log`, with the removal record that explains it or where to look, and a
`problem` on its `runs.json` entry, cleared when it recovers. A field, not a status: older
readers drop an entry with a status they do not know.

It never restarts the service. The incident behind it: postgres, redis and upstash got a
clean shutdown mid-run with no record anywhere, the apps kept running, `status` said
`ready`, and the run failed minutes later on Prisma errors. Whoever stopped them (a
deliberate `buncargo stop`, Docker Desktop restarting, the runtime itself) is unknown when
the watch fires; restarting would hide the one signal and race them.

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
A runner that does not let go in time gets SIGKILL after the same identity match, and one more
bounded wait: JavaScript handles SIGTERM only between calls, so a runner stuck in a synchronous
`docker` that hangs never exited, and every later run signalled it and gave up again.
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

## Detached runs that end

A `dev --detach` run sits in its own session and systemd scope, so nothing that started it can
end it: 13 were found on one machine 1 to 16 days old, several serving deleted worktrees.
`core/run-limits.ts` is the watchdog's pass for them, before each sweep. `decideRunLimit` is pure;
only an entry marked `detached` and live is a candidate, so a run in a terminal is never stopped,
and a detached run is left alone while a live terminal run shares its checkout, since that run may
be serving from the detached run's apps (`port-reuse.ts`) on `localhost`, out of the proxy's sight.
Stopping is `terminateRun`: SIGTERM to the run's group by recorded pid after an identity match,
what `stop --all` sends, so the run tears itself down and releases into the hold. The sweep takes
the containers from there; nothing here removes a container or a volume.

- A checkout confirmed deleted on two passes `DELETED_CHECKOUT_SETTLE_MS` apart stops its run,
  `--keep` or not. The first sighting is kept in the watchdog's memory, not on disk: a replaced
  watchdog only waits one more period.
- The idle limit (`idleLimitMs`, two hours, written by the detached run unless `--keep` or
  Tailscale mode, whose traffic never reaches the proxy) counts from the latest of the run's start,
  the last request through the proxy to its checkout, the last buncargo command in it, and the
  last watchdog pass that saw an established TCP connection on one of its app ports (an open tab's
  HMR socket, a client on `localhost:port` the proxy never sees; one `/proc/net/tcp` read on Linux,
  one `netstat` on macOS, only while a detached run has a limit). An
  entry without `idleLimitMs` (an older buncargo's run) is never stopped for idling.
- Requests: the hosts daemon counts each route lookup (every request and WebSocket upgrade, not
  the health path) by the route's checkout in memory and merges them into
  `~/.buncargo/proxy-activity.json` at most once a minute (`hosts/proxy-activity.ts`), and
  rewrites it every five minutes as a heartbeat. A missing file, or one silent for three beats,
  means no daemon counts requests (an older one put back by `hosts install` from a checkout on an
  older buncargo leaves the file frozen). A run is `unknown`, never stopped, only when neither its
  requests nor the connections can be read, because "nothing on record" would be no evidence.
- Commands: `bin.ts` sets the mtime of `<root>/.buncargo/last-command` on every command except
  `help` and `version` (`run-activity.ts`), with the root found as a run records it
  (`findCheckoutRoot`: the config's repository root, not the working directory). One `utimes`, no
  fork and no lock, since every command pays it; a directory without `.buncargo/` is left alone.
  `childProcessEnv` drops `BUNCARGO_DETACHED`, so a `buncargo dev` an app starts is not detached.
- The events log records each stop with its reason (`kind: "run-stopped"`), because the entry is
  gone soon after: `recentRunStops` picks what `stop` and `ls` print, the last day's newest per
  checkout with no run started there since.

## Volumes

`prune.ts` is the volume half, and it is deliberately not automatic: a container costs nothing to
recreate, a volume is the database. A volume needs positive evidence: `decideVolume`
(`volume-decision.ts`, pure) proposes one only when a claim in `offsets.json` names its Compose
project, every checkout claiming that project is confirmed deleted, and no container or entry names
it. It is the one owner of that rule: `prune`, the orphan report, `doctor` and the sweep's settling
of deleted checkouts all decide through it. An idle checkout after `dev --down` has neither containers nor an entry, and its claim is the
only thing saying its volume is still its database; when an unreadable claims file read as empty
and absence counted as orphaned, `prune --yes` offered every idle checkout's database. A suffixed
claim (`ci`, E2E) of an existing checkout keeps its stack's volume too; those are `prune --project`'s.

The claim is that record because it outlives the block: a claim that gave up its block (a full
range reclaimed it, or its throwaway run was torn down) stays, and the sweep drops a deleted
checkout's claim only once nothing of its project is left to propose, opt-in or not. Before, the
sweep dropped it on its first pass and a throwaway run's teardown deleted its claim, so plain
`prune` almost never had anything to propose. `prune --older-than=7d` proposes only checkouts
first found deleted at least that long ago (`deletedSeenAt`, below). After confirmation it decides
each project again under the deleted checkout's lifecycle lock, from fresh volume, container,
registry and claim inventories, and removes only what was listed.

Every read-modify-write of `offsets.json` reads it strictly: missing is empty, and a file that does
not parse or carries another `version` throws `StateFileUnreadableError` and is left as it is.
Several buncargo versions share the file, and a lenient write replaced every other checkout's
claim with its own.

Buncargo attaches **no labels to volumes**. Verified: Compose compares a volume against the file
and prompts "exists but doesn't match configuration in compose file. Recreate (data will be
lost)?", which hangs a non-interactive run. So a volume's checkout is unknowable, anonymous
(64-hex) Docker volumes are filtered out as never ours, and anything unattributable is counted and
left alone rather than guessed at.

One exception, opt-in per machine: with `BUNCARGO_PRUNE_DELETED_CHECKOUTS=1` the sweep also
removes a deleted checkout's volumes (`settleDeletedCheckouts`), for servers where agents create
and delete worktrees by the hundred. It works from the port claims in `offsets.json`, not from
container stacks: a checkout's claim names its root and project, and by the time a worktree is
deleted its containers are usually long gone, so a stack-driven rule would never see it. Its
suffixed environments' claims (E2E, `ci`) settle with it. It removes what `decideVolume` proposes,
so two checkouts sharing a project, a run on record of it, or a container of it still standing
keep the volumes; the last two defer the decision to the next pass, and a runtime that does not
answer defers everything. "Still has its checkout" includes one this user cannot read.

The watchdog also reports, at most hourly and only when the set changes, the volumes `prune` would propose (`orphan-report.ts`), by the same `decideVolume`, and `doctor` counts them and names `prune --dry-run`: on one machine 215 built up while it said "No issues found". It never removes them. Only runtimes that answered that pass are judged, each against its own containers. `buncargo ci` creates no volume to leave behind: its services keep their data on tmpfs.

Volumes need more proof than containers. A deletion counts only when confirmed (`ENOENT`) on two
passes at least `DELETED_CHECKOUT_SETTLE_MS` (10 minutes) apart (`VolumeState.deletedFor`): the
first sighting is stamped on the claim as `deletedSeenAt` under the claims lock, and cleared if
the checkout is back, so an
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
- `menubar/fixtures/runs.v2.json` is the schema contract. `menubar/scripts/smoke-test.sh` runs the
  app's `--status` mode against it and `src/core/run-registry.fixture.test.ts` decodes the same
  file, so a field one side drops fails a test on both.
- It decodes each run on its own and drops one it cannot read, and reads a status it does not know
  as `starting`. The app and the CLI release on their own, so a field or status from a newer CLI
  must cost one row at most; decoded as one array, a single such entry emptied the menu.
  `menubar/fixtures/runs.v2.lossy.json` holds those entries, and `RunRegistryTests` and the
  fixture test above both read it.
- It decides liveness by the CLI's rule, not by the pid alone: `ProcessIdentity` reads the start
  time from `sysctl` and encodes it as `process-identity.ts` does (`v2:` and the SHA-256 of `ps`'s
  C-locale UTC `lstart`), so the two cannot drift without `RunRegistryTests` failing. With the pid
  alone, a reused pid showed a crashed run, and its Stop took down the containers it held. An
  identity it cannot read keeps the row unless the sweep stamped the run `lost`.
- A run's dot rolls up its apps and its services, and a service with a `problem` reads failed.
- `RunRegistry.stateDirectory` reads `HOME` before `homeDirectoryForCurrentUser`, which ignores the
  environment. Without that the smoke test is silently handed the developer's real registry.
- `src/core/menubar.ts` is the app from the CLI side: detection, GitHub release download with
  checksum verification, install, update, uninstall. The CLI is the only updater
  ([bar updates](../bar-updates.md)); the app has no checker, so two updaters never race on one
  bundle. `fetchLatestBarRelease` filters the releases list by the `bar-v` tag prefix rather than
  using `releases/latest`, which would return whichever tag was published most recently, usually a
  CLI one.
