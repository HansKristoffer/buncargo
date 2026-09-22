# Container cleanup: why containers leaked and what replaced it

> **Status (2026-09-22): built, as a clean swap, same day as the plan.**
> Written after Docker Desktop showed ~20 stopped `gey-t3code-*` /
> `lullu-t3code-*` containers from worktrees that were long gone, and after
> finding running containers whose owning run had exited hours earlier.
> The "Plan" section below is the original; "What shipped" records where the
> build deviated. `AGENTS.md` under `src/container-runtime/` describes the
> design as it now is.

## The one design fact everything below follows from

Nothing in buncargo removed a container except two things: the developer
typing `dev --down`, and the per-project watchdog, a detached Bun process
that `spawnWatchdog` started once per run and that ran `compose down` a few
minutes after the run's heartbeat stopped. Every normal exit — Ctrl-C, the app
crashing, `buncargo stop`, the takeover — released the heartbeat and *handed
the containers to the watchdog*. So cleanup was exactly as reliable as one
unsupervised process surviving for three minutes after its parent was gone,
and no later buncargo command ever noticed when it did not.

That was the bug. The fixes were (1) make the watchdog's `down` unable to fail
on the case it is for, and (2) stop relying on it alone: sweep the machine for
containers nobody owns any more.

## What the evidence on this machine showed

State lived in `/tmp/<project>-<roothash>-{heartbeat,watchdog.pid,watchdog.log}`.
Reading those for the projects in the screenshot:

| Symptom | Evidence | Cause |
|---|---|---|
| Containers running with no run | `gey-t3code-687e092a`: heartbeat released 13:24 today, watchdog log ends at "Started", pid file removed, no runner process | The watchdog got SIGTERM and exited. Its handler only unlinked the pid file; it never tore down. Most likely the T3 Code thread's process tree was killed while `dev` was still the runner's parent. Same pattern for `lullu-t3code-86928c60` and `-a26647c8` on Sep 18. |
| Containers up, nothing ever watching them | `gey-t3code-58b0eb5f`, `-e6e23859`, `-ed2ebf8c`, `-6b608977`, `-91d0fd35`: released heartbeats from `env.start()`, **no watchdog log at all** | `run-cli.ts` spawned the watchdog only on the long-running path, after the one-shot exits. `dev --up-only`, `--migrate`, `--seed` started containers and left without a heartbeat or a watchdog. A failure inside `env.start()` (migration, seed) did the same and printed "containers are still running". |
| Stopped containers that piled up (the screenshot) | Docker Desktop's VM restarted 12:28 today; `buncargo stop <service>` and `dev --down --all` used `docker stop`, not `down` | A stopped container is still a container. No path removed an *exited* container except `compose down`, which only the dead watchdog would have run. Every daemon restart converted the running leak into the stopped leak. |
| A watchdog that could not tear down once the worktree was deleted | `watchdog-runner.ts` ran `down` with `cwd: root` and `-f <root>/.buncargo/compose.yml` | Deleting a t3code worktree made `spawn` fail with ENOENT (cwd) or compose exit 14 (file). The runner's `shutdownContainers()` threw through `withWatchdogProjectLock`, the runner exited 1, and the containers stayed. Verified: `docker compose -p <name> down` with no `-f` exits 0 and removes by label. |

Not a cause, checked and dismissed: macOS purges old files in `/tmp`
(empty `*.owners` dirs from Sep 20/21 proved it), but heartbeats were
rewritten every 10 s and a purged pid file only meant a second, idempotent
watchdog. The state moved to `~/.buncargo` anyway, for the clean swap, not
for this.

## Plan (as written before building)

### Phase 1: `down` must work with the worktree gone

- `stopContainers`: pass `-f` only when the compose file exists on disk; use
  a directory that exists as `cwd`. `down` finds containers by the compose
  project label; the file is only needed for `-v`, so when it is gone and
  `removeVolumes` was asked for, warn and skip volumes.
- Watchdog runner: a failed `down` is logged and retried next tick instead of
  ending the runner.

### Phase 2: sweep orphaned containers

A pure `decideSweep`: checkout gone → down; owner alive → keep; all stopped →
down; released longer than the idle timeout → down; otherwise keep. Applied to
every `(project, root, runtime)` group under the project lock, from `dev`,
`ls`, `doctor`, and `dev --down --all` (which switches from `stop` to `down`).

### Phase 3: failed and one-shot starts get a backstop

Spawn the watchdog before `env.start()`. One-shot modes keep no idle hold:
**containers live as long as their checkout.**

### Phase 4 (optional): double-fork the runner so tree-walking killers never see it

## What shipped

| Plan item | Outcome |
|---|---|
| `down` without `-f` / checkout `cwd` | Done, `src/docker/lifecycle.ts`; `src/docker/lifecycle.test.ts` asserts the argv both ways. Verified live: a compose-created stack whose directory was deleted came down, network included. |
| Runner retries instead of dying | Done, but the runner itself changed shape: see next row. |
| Sweep beside the per-project watchdog | **Changed.** The sweep *is* the watchdog. One machine-wide runner (`core/watchdog-runner.ts`) polls `sweepOrphanedContainers` every 10 s and exits when nothing is left to watch; any `dev` restarts it via `ensureWatchdog`. The per-project runner, its env vars, pid/log files and `watchdog-decision.ts` are gone. |
| `decideSweep` rules | Done as planned, plus one: a running stack with no heartbeat at all is left alone (only the checkout-gone and all-stopped rules may touch it). `src/container-runtime/sweep.test.ts`. |
| Sweep from `dev` | **Changed.** `dev` starts the runner instead of sweeping inline, so startup pays nothing and the log line lives in `~/.buncargo/watchdog.log`. `ls` and `doctor` sweep inline and print what they removed. |
| `dev --down --all` uses `down` | Done; `stop-all.test.ts`. Stopping a whole run from the menu bar also `down`s now. `buncargo stop <service>` keeps `docker stop`. |
| Watchdog before `env.start()` | Done: the CLI claims the heartbeat with its flags and calls `ensureWatchdog` before `env.start()`. |
| One-shot rule | Done and in the readme: `--up-only`, `--migrate`, `--seed`, `--keep-containers` and `autoShutdown: false` write no idle hold. |
| Phase 4 double-fork | Not built. Moot: a killed runner is replaced by the next `dev`, `ls` or `doctor` anywhere. |
| Heartbeats | **Changed.** Moved to `~/.buncargo/heartbeats/<project>-<hash>/`, carry `idleTimeoutMs`, `runtime` and `binary`, one owner per environment, no legacy single file. |
| Adapter interface | **Extra.** `ContainerRuntimeAdapter` is async-only; the sync twins, `areServicesRunning`, `isContainerRunning`, `areContainersRunning` and the dead heartbeat exports are deleted. `docker/exec.ts` still resolves the container through Compose's own labels because it needs the replica number, which buncargo's labels do not carry. |
| Manual "killed watchdog" check | Not run end to end. The path is covered by `sweep.test.ts` (released past the hold → down) and by running `ls` live against a real stack. |

## The second round: what shipped

Built in five phases, same session. Lint, typecheck, build and 1038 unit
tests green; `prune --dry-run` and the sweep verified against real Docker,
and the menu bar's `--status` smoke test against the extended fixture.

| Phase | Outcome |
|---|---|
| **A** — two deletions | `DevEnvironment.autoShutdown` (read by nothing) gone. `BuncargoContainer.state` added from Docker's `{{.State}}` and Apple's own state; `isContainerUp` reads it instead of searching `Up 3 minutes` for a substring. `docker/inventory.test.ts`. |
| **B** — runner idle cost | `readProcessIdentities(pids)` is one `ps` for a whole tick instead of one fork per owner, and the run registry's prune uses it too. `stopContainers` no longer probes the daemon up front; it reads compose's own failure, falling back to a probe only when a verbose run streamed that failure to the terminal. Poll interval 10s → 30s. `process-identity.test.ts`, `docker/lifecycle.test.ts`. |
| **C** — one liveness record | Heartbeats deleted. `runs.json` gained `releasedAt` and `idleTimeoutMs`; `environment/run-claim.ts` publishes the entry before the first container, the CLI enriches it under the same session id, and `releaseRun` marks it finished rather than withdrawing it. Prune keeps entries that own services; the sweep retires them once their containers are gone, and only when a runtime answered. `withWatchdogProjectLock` → `container-runtime/project-lock.ts`. `ensureWatchdog` lost its spawn lock: the runner's own flock is the answer, and a losing duplicate exits silently. |
| **D** — what the merge made easy | `doctor` names the worktree and pid owning foreign containers. `stopServiceUnlocked` takes the runtime from the entry and patches sharing sessions in one pass. `ls` annotates each stack with its run: active, or held with the time left. |
| **E** — `buncargo prune` | New command, `--dry-run` / `--yes`, listing volumes whose project has no containers and no run and removing them only on confirmation. `container-runtime/prune.ts` holds the pure rule; `docker/volumes.ts` and `apple-container/volumes.ts` the listings. |

### Two findings that changed the design

**Volumes cannot be labelled.** The plan assumed prune could learn a volume's
checkout from a `buncargo.root` label. Tested first: adding any label to an
existing volume makes Compose print *"Volume … exists but doesn't match
configuration in compose file. Recreate (data will be lost)?"* and **wait for
an answer** — which hangs every non-interactive `dev` and offers to destroy a
database. So buncargo attaches no volume labels, prune attributes volumes by
Compose's own project label only, and anything it cannot attribute is counted
and left alone. Anonymous (64-hex) Docker volumes are filtered out entirely:
this machine has 270 of them, which buried the 138 that actually matter.

**A released entry needed the Swift side after all.** The plan argued
`runs.json` could stay v1 because the app hides dead pids. True, but a
released entry now outlives its process, widening the pid-reuse window in
which a finished run could reappear in the menu. `Run.releasedAt` and a
one-line change to `isAlive` close it; the fixture gained a released run and
the smoke test asserts the app hides it.

### Tested on this machine, against the playground example

Run end to end after the five phases, which is what found the last two items:

| Scenario | Result |
|---|---|
| `dev --up-only` | Container up; one entry claimed with the runtime, no `idleTimeoutMs` (the one-shot rule), watchdog started. |
| `ls` | Annotated the stack "held until this checkout is removed" and its inline sweep correctly left it alone. |
| `dev` (full run) | One entry, live, apps `api`/`web` ready and postgres ready — the library's claim and the CLI's publish merged under one session id rather than two entries. |
| `dev --down` | Containers and network removed; the entry retired by the next sweep once its containers were gone. |
| `pkill -9 -P <dev>` | **Found the bug below.** After the fix: the watchdog survived and reclaimed the stack itself within 5s. |

**The watchdog was still dying with the run.** Phase 4 of the first round —
double-forking so the runner escapes the process tree — was dismissed there as
"moot, a killed runner is replaced by the next `dev`, `ls` or `doctor`". The
test showed it is not moot: `detached: true` gives the runner its own session
but leaves it a *child* of the `dev` process, and `pkill -P` enumerates
children by parent pid. So the exact failure this whole change was built for
still killed the watchdog, leaving the containers to wait for the user's next
buncargo command. `ensureWatchdog` now spawns through a throwaway intermediate
that exits at once, so launchd adopts the runner before the function returns.
Verified: parent pid 1, absent from the `dev` process's children, survives the
tree kill, reclaims in 5s. `watchdog.test.ts` asserts the parentage.

**An explicit `--watchdog-timeout` was ignored on one-shot runs.** The
one-shot rule returned "no hold" before the flag was consulted, so
`--up-only --watchdog-timeout=5` left containers up forever. `--keep-containers`
still wins (it is itself explicit), then the flag, then the one-shot default.

Also surfaced and *not* fixed, being neither caused by nor in scope for this
change: `.biomeignore` has been inert since Biome 2.0 removed it, so running
the playground and then `bun run lint` fails on the generated
`example/playground/.buncargo/` files. The fix is a `biome.json` with
`files.includes`, which is a config decision of its own.

### Deviations worth knowing

- **Phase B's "sweep returns its readings" folded into C.** Building it on
  heartbeats would have meant deleting it in the next phase; the runner's
  exit condition now reads `liveRuns` from the sweep, which is the same
  result against the registry.
- **`ls` still lists containers.** The plan said it could answer without a
  container listing; it cannot, because the sweep it runs needs one. It reads
  the registry to *annotate* each stack instead.
- **Stale `ports.json` is not prunable.** That file lives inside the checkout,
  so a deleted checkout takes it with it. `doctor` already reports the only
  reachable case, a project/root mismatch.
- **`claimRun` rather than `start({ idleTimeoutMs })`.** One idempotent claim,
  called by the CLI with its flags and again by `start()` with the default,
  beats two entry points — and keeps the claim ahead of `env.start()`, where
  it has to be.
- **The crash grace changed meaning.** The old heartbeat was rewritten every
  10s, so the 15s grace measured time since death. `updatedAt` is written on
  claim, publish and patch only, so it now measures staleness: a run that
  crashes after a quiet spell loses its containers on the next sweep instead
  of 15s later. Keeping it exact would mean every live run rewriting the
  registry on a timer — the periodic writer this round removed — to buy warm
  container reuse after a crash. Documented on the constant rather than fixed.
- **Apple volumes are unattributable.** Apple records no Compose project and
  its `<project>-<volume>` names cannot be split back apart. They are listed
  and skipped, not guessed at.

## The original second-round plan

Everything here is committed work, in this order. Each phase is one PR that
leaves lint and the suite green; a later phase never depends on the user
accepting an earlier one, but the order is chosen so that each phase makes the
next one smaller. Phase C deletes most of what Phase B touches in
`core/watchdog.ts`, which is why B only batches and does not restructure.

### Phase A: two trivial deletions, first

- **Delete `DevEnvironment.autoShutdown`.** Set in `create-dev-environment.ts`,
  read by nothing since the CLI stopped computing the idle hold itself. Public
  type, so it rides the same `feat!` release as the rest.
- **Give `BuncargoContainer` a real `state`.** `isContainerUp` searches the
  human status for `up` or `running`, and the sweep's all-stopped rule hangs
  off that. Docker's listing gets `{{.State}}` next to `{{.Status}}`
  (`running`, `exited`, `restarting`, `paused`); Apple already has one. One
  column in `docker/inventory.ts`, one field on the type, `isContainerUp`
  reads the field, heuristic gone. `parseDockerContainerLine` test covers it.

### Phase B: cut the runner's idle cost

Every 10 s tick, with N live runs on macOS, the runner forks `docker info`
(availability), `container system status` on Apple silicon, `docker ps -a`,
and about 2N × `ps`, because `readProcessIdentity` shells out per live owner
and `hasLiveHeartbeat` reads every owner a second time. Each `down` adds a
`docker info` inside `stopContainers`. Three open runs is roughly nine forks
per tick, forever, for a process whose job is to do nothing most of the time.

- `core/process-identity.ts` gains `readProcessIdentities(pids)`: one
  `ps -o pid=,lstart= -p a,b,c` for every pid in the tick. The per-pid
  function calls it with one pid, so nothing else changes. Every reader of
  `runs.json` benefits too, since `prune` does the same per-entry fork today.
- `sweepOrphanedContainers` returns the readings it took; the runner decides
  "anything live?" from those. `hasLiveHeartbeat` goes.
- `stopContainers` drops `isDockerDaemonRunning`. Every caller already knows
  the daemon is up: the sweep listed, and `dev --down` catches compose's own
  error and prints the friendly line itself.
- `WATCHDOG_POLL_INTERVAL_MS` becomes 30 s. The shortest window is the 15 s
  crash grace; a stack removed 30 s after a crash instead of 15 s costs nobody
  anything. The readme's "every 10s" follows.

### Phase C: one liveness record per run

`~/.buncargo/runs.json` and the heartbeats both answer "is this run alive?"
with a pid and a process identity, and both carry root, project and container
runtime. The heartbeat adds three things: a released-at timestamp, the idle
hold, and coverage of library runs that never publish a registry entry. Those
move into the registry, the heartbeats are deleted, and `core/watchdog.ts`
is left holding only `ensureWatchdog` and the pid file.

What changes, precisely:

- **`RunEntry` gains `releasedAt?: string` and `idleTimeoutMs?: number`;
  `RunServiceEntry.container` already carries runtime and binary.** Both
  optional, so `runs.json` stays version 1: the Swift reader ignores unknown
  keys and already hides any entry whose pid is dead. The dead pid is kept in
  the entry, never zeroed: Swift's `kill(0, 0)` would signal its own process
  group. `fixtures/runs.v1.json` gets a released entry so the app's `--status`
  check in CI proves it still decodes.
- **`start()` claims before the first container.** The library publishes a
  minimal entry (project, root, pid, identity, session id, services with
  their container runtime and binary, idle hold) inside `ensureSubset`'s lock
  before `up`, which is exactly when the heartbeat is written today. The CLI's
  `publishCurrentRun` patches apps, hosts and the rest onto that entry later;
  it stops generating the session id itself and reads `env.sessionId`.
- **`stopHeartbeat()` becomes `releaseRun()`**: sets `releasedAt`, keeps the
  entry. `withdrawCurrentRun` withdraws outright only for app-only runs, which
  have nothing for the sweep to do. The `env.startHeartbeat` /
  `env.stopHeartbeat` names go; `startHeartbeat`'s `idleTimeoutMs` option
  moves to `start({ idleTimeoutMs })`.
- **Pruning splits in two.** `prune()` on every read keeps dropping dead
  entries that have no services. Entries with services are retired only by
  the sweep, under the `runs.json` lock, once their containers are gone.
  `readLiveRuns`, `findRunsByRoot`, `stop` and the menu bar keep their
  "alive" filter, so a released entry is invisible to all of them.
- **`decideSweep` reads a `RunEntry`** instead of a heartbeat: owner alive →
  keep; `releasedAt` set → down after `idleTimeoutMs` (absent means never);
  dead without `releasedAt` → down after the grace measured from `updatedAt`;
  checkout gone or all stopped → down as today. A stack with no entry at all
  is left alone as today.
- **`withWatchdogProjectLock` stays**, keyed on project and root, because it
  is the mutual exclusion between `up`, `down` and the sweep, not a heartbeat
  concern. It moves to `container-runtime/` and is renamed
  `withProjectLifecycleLock`. The `.spawn` lock in `ensureWatchdog` goes: a
  try-acquire of the runner's own flock answers "is one running?"; the pid
  file stays for `doctor` to print.
- **Deleted:** `core/watchdog.ts`'s heartbeat half, `~/.buncargo/heartbeats/`,
  the one-owner-per-environment machinery in `environment/watchdog.ts`,
  `createHeartbeatOwner`, and the heartbeat tests. The directory-retirement
  problem (one heartbeat directory per checkout, never removed) disappears
  rather than needing a rule.
- **Gained:** the menu bar sees library runs; `ls` can print "released 2 min
  ago, removed in 1 min" from the same entry it lists containers for; `stop`
  no longer needs a separate heartbeat check to decide whether services are
  shared, because the other session is an entry in the same file.

Tests: `run-registry.test.ts` for the two prune rules and the release
transition; `sweep.test.ts` rewritten against `RunEntry` fixtures;
`lifecycle.test.ts` asserting the claim precedes `up`; the fixture test for
the released entry; `run-cli.test.ts` for the CLI patching onto the library's
entry rather than replacing it.

### Phase D: what the merge makes easy

- **`doctor` names runs.** After the sweep, "N containers labeled X belong
  to another root" only ever describes owned stacks. With the run in the same
  registry, say which worktree and pid own them.
- **`stopServiceUnlocked` shrinks.** It lists every runtime and patches every
  session sharing the service. With sessions in one registry that is one
  filter and one patch; and it takes the container runtime from the entry it
  already has instead of probing.
- **`ls` reads the registry first** and lists containers only for stacks that
  have no run, so a machine with three live runs and no orphans answers
  without a container listing.

### Phase E: `buncargo prune`

A deleted worktree loses its containers but keeps its named volumes. That is
deliberate for the sweep: it must never destroy data on a heuristic. So the
data path is explicit and interactive:

- `buncargo prune` lists, per runtime, every `<project>_*` volume whose
  project has no containers and no run in the registry, with its size where
  the runtime reports one, and asks once before removing them all. `--yes`
  skips the prompt for scripts. `--dry-run` only lists.
- It also lists and removes the retired registry entries and any stale
  `<root>/.buncargo/ports.json` whose root is gone, so one command answers
  "clean up after my worktrees".
- Docker: `docker volume ls --filter label=com.docker.compose.project=<p>`;
  Apple: `projectVolumeNames` needs a model, so Apple prunes by the
  `<project>-` name prefix the run plan already uses. `command-spec.ts`
  carries the flags; a `prune.test.ts` covers the decision with a stub
  runtime, as `stop-all.test.ts` does.
- The readme's troubleshooting table gets a row: "disk full of old volumes →
  `buncargo prune`".

### Leave alone, and why

- `docker/exec.ts` resolving through Compose's own labels: it needs the
  replica number, which `buncargo.*` labels do not carry.
- The old `/tmp/*-heartbeat` and `*-watchdog.*` files on developer machines:
  inert, and this was a clean swap with no legacy handling.
- Where `ensureWatchdog` is called: before `env.start()` on purpose, so a
  start that fails in migrations still leaves a backstop.
- A launchd service for the watchdog, or double-forking the runner: `dev`,
  `ls` and `doctor` restarting it is the same guarantee with no service to
  keep alive.
