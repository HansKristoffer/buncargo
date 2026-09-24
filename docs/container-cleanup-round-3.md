# Container cleanup, round three: simplify and harden

> **Status (2026-09-24): built**, except items 4 and 13, which are the
> user's to take. A review of what rounds one and two shipped (PR #54, merged
> as `e2356c2`), read against `main` rather than from memory. Background:
> `docs/container-cleanup-plan.md`. Every finding below was checked against
> the code or measured on this machine; none is inferred. "What shipped", at
> the end, records the outcome and two further bugs the build turned up.

## Where things stand

The fix is merged but **not released and not in use**. npm is at 9.2.2, and
the release PR that would cut 10.0.0 (#52) is still open. The projects that
leaked in the first place pin older versions — `gey-mono` worktrees run
buncargo 7.7.1, `lullu` runs 9.2.1 — so they still run the old per-project
watchdog. On 2026-09-24 this machine had 20 containers in seven exited stacks
that no registry entry and no watchdog owned. That is the original bug,
still happening, and no code change here reaches it until the release ships
and those projects upgrade.

## P0 — correctness bugs

### 1. The menu bar's Stop can re-run the user's own script

`environment/run-claim.ts` records `cli: { program: process.execPath,
script: process.argv[1] }`, and `cli/run-publish.ts` does the same through
`currentCli()`. The menu bar runs every mutation as
`<program> <script> stop <name> --root … --run …` (`Actions.swift`).

That is only right when `argv[1]` *is* buncargo's CLI. For a script calling
`dev.start()`, `argv[1]` is the user's script, so Stop executes it again —
starting a second environment — instead of stopping anything. The same holds
for a script wrapping the exported `runCli`, where it predates this work.
Round two made it reachable for library runs, because it made them visible in
the menu bar for the first time.

**Fix:** one helper that resolves buncargo's own CLI entry from
`import.meta.url` (`dist/cli/bin.js`, or `src/cli/bin.ts` from source — the
same search `resolveWatchdogRunnerPath` does), used by both writers.
**Test:** an entry built by a library `start()` records a `cli.script` ending
in `cli/bin.js`/`bin.ts`, never the test file.

### 2. One bad tick kills the watchdog

`watch()` in `core/watchdog-runner.ts` awaits `sweepOrphanedContainers()`
with no guard. Two ordinary conditions throw out of it and end the runner:

- `readAllRuns()` reads in strict mode, so a `runs.json` caught mid-write or
  hand-damaged throws.
- `retireFinishedRuns` takes the registry lock with the default 5s timeout
  and sits outside the per-stack `try`, so a busy registry throws
  `FileLockTimeoutError`.

The runner then logs "Watchdog failed" and exits, and nothing sweeps until the
next buncargo command — the exact gap round two closed for the process-tree
kill. `ls` and `doctor` crash on the same errors.

**Fix:** catch per tick, log, carry on. Inside the sweep, treat an unreadable
registry as "cannot decide": skip the pass rather than guess, because
treating every stack as unowned is how it would destroy something.
**Test:** a sweep over a corrupt `runs.json` returns without removing
anything, and a runner survives a tick that throws.

## P1 — coverage gaps

### 3. Library runs never get a watchdog

`start()` claims containers but never calls `ensureWatchdog()`; only
`run-cli.ts` does. A script that calls `dev.start()` and then crashes leaves
its stack to wait for somebody's next CLI command.

**Fix:** `start()` ensures the watchdog right after claiming, not awaited, the
way the CLI does. Opt-out: `StartOptions.watchdog?: false`, which the test
suites that call a real `start()` pass. Related: `CliOptions.watchdog: false`
no longer means "no watchdog involvement" — `start()` claims regardless — so
rename or document it in the same change.

### 4. Ship it

1. Merge release PR #52 (10.0.0; the `feat!` makes it a major).
2. Bump `buncargo` in `gey-mono` (7.7.1) and `lullu` (9.2.1).
3. Run `buncargo ls` once after upgrading: it sweeps inline and reclaims the
   seven exited stacks. Then `buncargo prune --dry-run` for the volumes.

This is the step that actually ends the leak. It is listed here because it is
the user's to take, not because it is small.

## P2 — measured efficiency

### 5. The sweep re-checks liveness per call and probes before listing

Round two batched process identities for `runs.json` reads, but the sweep
never used it: `isRunAlive` runs per entry, per group in `runFor`, again for
`ownerAlive`, and again in `retireFinishedRuns`, and each call forks `ps` on
macOS. It also asks `isAvailable()` (`docker info`) before `list()`
(`docker ps`), when a failed listing already means "unavailable".

Measured on this machine, one tick with three live runs and 20 containers:

| Process | Spawned |
|---|---|
| `ps` | 11 |
| `docker info` | 1 |
| `docker ps` | 1 |
| `container system status` | 1 |
| **Total** | **14** |

**Fix:** read liveness once per sweep with `processIdentityMatcher` and pass
the answer down; call `list()` per runtime directly and record which ones
answered, which is also exactly what the retire guard needs. Expected: one
`ps`, one `docker ps`, and one `container` call on Apple silicon. Return the
listing from the sweep so `ls` and `doctor` stop listing a second time.

## P3 — simplifications

### 6. One run-entry builder, and publish becomes a patch

The registry has two writers that each build a full `RunEntry` — the library
claim and the CLI publish — with duplicated worktree, identity and CLI logic
(the CLI path duplicated into bug 1). To make them compose, `publishRun`
special-cases preserving `startedAt` and `idleTimeoutMs`, and
`run-publish.ts` keeps a `currentSessions` map from root to session id that
`env.sessionId` has made redundant.

**Fix:** one builder in `core/run-registry.ts`. The claim writes the entry;
the CLI *patches* apps, hosts, branch, primary app and rich service fields
onto it by session id. The merge special case and the map both go. Fix the
`AGENTS.md` line that still calls `run-publish.ts` "the only writer".

### 7. Finish the clean swap in the registry

Every writer now sets a session id, but the code still carries the
sessionless path: `sessionId` optional in the type and validator,
`!run.sessionId` branches in publish, `sessionId === undefined` fallbacks in
patch, release and withdraw, and the registry's `claimRun` take/keep/conflict
function that only sessionless entries reach. Three exports have no callers:
`withdrawRun`, `findRunByRoot`, `pruneRuns`.

**Fix:** require `sessionId` on the TypeScript side and delete the rest. That
also removes the confusing collision between the registry's `claimRun` and
`env.claimRun`. The Swift reader keeps decoding it as optional, so older
files still load there.

### 8. Release once; a deliberate stop retires

`releaseRun` stamps a fresh `releasedAt` every time and has three callers —
teardown, the signal handler, and `stop()` — so the hold creeps later by
however long teardown takes. And `stop()` *releases* the entry even though it
has just torn the containers down, leaving the entry for a later sweep.

**Fix:** keep the first `releasedAt`. Have `stop()` retire the entry after a
successful `down`, since it knows there is nothing left to hold.

## P4 — smaller items

### 9. An exact crash grace, without a periodic writer

The crash grace is measured from `updatedAt`, which is only written on claim,
publish and patch, so a run that crashes after a quiet spell loses its
containers on the next sweep. Round two documented this rather than fix it,
on the reasoning that exactness needs every live run rewriting the registry
on a timer. It does not: the sweep can stamp `ownerLostAt` the first time it
finds an unreleased entry whose owner is gone, and measure the grace from
that. One write per crash, none while runs are healthy.

### 10. Hermeticity, written down

Measuring item 5 ran the sweep with an isolated `HOME` but the real Docker.
With the real registry hidden, all 20 real containers looked unowned, and the
sweep issued seven `down`s. They changed nothing — under that `HOME`, Docker
Desktop's Compose plugin is not found and every `down` failed — and they
matched what the real sweep would have done anyway. It was still the wrong
setup.

- **Rule for `AGENTS.md`:** anything that runs the sweep must isolate the
  container runtime too — stub adapters or an empty `PATH` — not just `HOME`.
  Isolating only the registry makes every real stack look orphaned.
- **Finding:** `docker compose` is found through the user's `~/.docker`. A
  watchdog whose `HOME` differed would fail every `down` and log it every
  tick. Detect "'compose' is not a docker command" once and log a single
  remediation line instead of the same failure forever.

### 11. Mixed versions on one machine

Until every project upgrades, old and new runs coexist. Checked against the
sweep's rules: an old run's *running* stack has no entry and is kept; an old
run's *fully stopped* stack is removed, which its own old watchdog would also
do. The one divergence is a live old run whose services are all stopped. Rare
and recoverable, since volumes are never touched — worth a sentence in the
readme's upgrade note, not code.

### 12. Housekeeping

- `.biomeignore` has been inert since Biome 2.0, so linting after running the
  playground fails on its generated `.buncargo/` files. Replace it with a
  `biome.json` using `files.includes`.
- The one-shot modes never publish the enriched entry, so an `--up-only`
  entry lists its services as `starting` forever. Invisible today, since only
  the sweep reads released entries; item 6 fixes it as a side effect.
- Project lifecycle lock files in `~/.buncargo/locks/` accumulate, one per
  project and checkout. `file-lock.ts` forbids unlinking them, and each is
  empty. Accept it.

### 13. Still unverified: Apple's live path

Apple `container` up, down and exec have only been typecheck- and
unit-tested. Every adapter method degrades correctly against the real binary
with its system stopped. Running the integration suite needs
`container system start`, which registers a launchd service — the user's
call.

## Leave alone

Each of these was proven necessary, so none should be "simplified" back:

- **Both watchdog locks.** Collapsing them let two callers each spawn a
  runner; Linux CI caught the loser starting after the winner was stopped.
- **No labels on volumes.** Compose prompts to recreate a volume whose
  definition changed, which hangs non-interactive runs.
- **The double fork.** `detached` alone left the runner inside `dev`'s
  process tree, and a `pkill -P` took it with the run.
- **`down` without `-f` or the checkout as `cwd`.** Deleted worktrees must
  still come down.
- **`prune` stays manual.**

## Order

1 and 2 first, as one small PR: they are the only items that can make things
worse than before round two. Then 4, so the leak actually stops. Then 3 and 5.
Then 6, 7 and 8 together, since they touch the same registry code. Then 9–12
as they come up.

## What shipped

Lint, typecheck, build, the full unit suite, the packed-package verifier and
the menu bar smoke test all pass. The sweep's per-pass cost was measured again,
hermetically this time — Docker pointed at a socket that does not exist, so
the pass could list and remove nothing:

| One pass, three live runs | Before | After |
|---|---|---|
| `ps` | 11 | 1 |
| `docker info` | 1 | 0 |
| `docker ps` | 1 | 1 |
| `container system status` / `container ls` | 1 | 1 |
| **Total** | **14** | **3** |

| Item | Outcome |
|---|---|
| 1. Stop re-runs the user's script | Fixed. `core/cli-entry.ts` resolves buncargo's own CLI by walking up to the package's `src` or `dist` and returning the entry of the same flavor. Both writers record it through `buildRunEntry`. Falls back to `buncargo` on `PATH` for a layout it cannot recognize. |
| 2. One bad tick kills the watchdog | Fixed. The loop moved to `core/watchdog-loop.ts`, where a pass that throws is logged and retried, and a repeated failure is logged once. The sweep throws on an unreadable registry *before* touching anything; `ls` reports it, `doctor` lists it as an issue, the watchdog retries. A busy registry during retirement is skipped until the next pass. |
| 3. Library runs get a watchdog | Done. `start()` ensures it right after claiming; `StartOptions.watchdog: false` opts out. The CLI claims whether or not `watchdog` is set, since the claim is what marks the containers as somebody's. The Docker verifier in CI opts out so a real watchdog cannot race its assertions. |
| 4. Ship it | **Not done — the user's call.** Merging release PR #52 publishes to npm. |
| 5. A cheaper sweep | Done, measured above. Liveness is read once per pass; runtimes are listed without probing, and a failed listing records that the runtime did not answer. Retirement now requires the answer from the runtime that holds the entry, not just any runtime. `ls` and `doctor` reuse the sweep's listing. Apple's `list()` throws when the system is down instead of returning nothing, so "down" can no longer look like "empty". |
| 6. One entry builder | Done. `buildRunEntry` is the only constructor; the `currentSessions` map is gone, and patches are addressed by `env.sessionId`. **Deviation:** `publishRun` still carries the claim's `startedAt` and hold across a re-publish. Removing that meant patching apps into an entry that does not list them, which `patchRun` refuses on purpose; the carry-over is now the documented upsert rule instead. |
| 7. Registry clean swap | Done. `sessionId` is required and entries without one are dropped on read. `claimRun` (the registry's take/keep/conflict), `withdrawRun`, `findRunByRoot`, `pruneRuns` and the sessionless branches are gone, and so is `recordAppPids` — see the second finding below. |
| 8. Release once; stop retires | Done. The first `releasedAt` wins. `stop()` retires its own session and any finished session for the same checkout. |
| 9. An exact crash grace | Done. The sweep stamps `ownerLostAt` the first time it finds an unreleased owner gone, and counts the grace from there. A stamp it cannot write leaves the stack for the next pass rather than removing it early. |
| 10. Hermeticity | Done. The rule is in `AGENTS.md`, and a missing Compose plugin now fails with a message saying so. The watchdog loop's once-per-change logging covers the "same failure every pass" half. |
| 11. Mixed versions | Documented in the readme's upgrade note, including a case the plan missed: an old CLI pruning the shared registry drops a new run's hold early. That leaves containers up rather than removing them. |
| 12. Housekeeping | `biome.json` replaces the inert `.biomeignore`: same 338 files checked, and generated `.buncargo/` files are now ignored. The one-shot `starting` status was **not** fixed as a side effect of item 6, because the one-shot path still skips the CLI's publish. It is invisible, since only the sweep reads released entries, so it was left. Lock files: accepted, as planned. |
| 13. Apple live path | **Not done — the user's call.** It needs `container system start`, which registers a launchd service. |

### Three more found by an independent review of the diff

A reviewer with no part in writing the change read it cold. Each finding was
reproduced before it was fixed.

- **Identities depended on the reader's locale and time zone.** On macOS the
  identity hashes `ps -o lstart`, which follows the caller's `LC_*` and `TZ`:
  the same pid reads `Thu Sep 24 15:18:09 2026` in one shell and
  `tor. 24 sep. 15:18:09 2026` in another. This machine's locale is Danish
  and agent shells run under `C.UTF-8`, so a watchdog spawned from one read
  runs started from the other as dead — and `stop`, run by the menu bar with
  a GUI environment, refused them. Worker ownership and the connect daemon
  compare identities across processes the same way. `ps` is now always asked
  in `LC_ALL=C` and UTC, and the new format is prefixed `v2:`. An unprefixed
  identity is an older version's: the strict check compares it exactly as
  before, and liveness forgives it, so a live 9.x run is never condemned over
  a format it could not have known. The reverse is not covered, by choice: a
  9.x CLI cannot read `v2:` identities, so whenever it writes the registry it
  drops every new-version entry, live ones included. Containers survive —
  a running stack with no entry is kept — but those runs vanish from `runs`
  and the menu bar and lose their hold. Carrying both formats through the
  registry would undo the clean swap; upgrading every project together closes
  the window, and the readme says so.
- **A script that started containers and exited lost them seconds later.**
  Nothing releases a library run's claim on a normal exit, so the sweep saw a
  crash. With `start()` now ensuring the watchdog, this would have hit every
  "bring the database up" script. A library claim now keeps its containers
  unless the script asks for a hold with `claimRun`; `options.autoShutdown`
  applies to `buncargo dev` only, as its docs already said ("Default: 180000
  when running via CLI"). A second review pass caught a first version of this
  fix still applying a configured `autoShutdown` to scripts. "No hold" now means
  "keep" on a crash too, which also fixes `--keep-containers` and the one-shot
  modes losing their containers when the run died.
- **The sweep decided on a snapshot taken before its lock.** A new run
  publishes its claim before taking the project lock, so a pass busy tearing
  down other stacks could remove containers a run had claimed in the meantime.
  A stack condemned from the snapshot is now decided again from a fresh read
  under its lock. Minor, fixed alongside: releasing did not touch `updatedAt`,
  so a crashed older session could outrank a later release when choosing a
  stack's owner.

### Two bugs the build turned up

**Liveness read live runs as dead.** The batched identity read from round two
asks `ps` about every pid in the registry at once, and `ps` refuses the whole
batch over a single pid it rejects. Liveness then read a process whose
identity could not be read as *dead*. The old heartbeat code had done the
opposite on purpose, and round two lost it. On `main`, one odd pid in
`runs.json`, or a `ps` that hit its one-second timeout on a busy machine, made
every live run look dead. `buncargo runs` and `stop` went blind, and the sweep
could condemn a live stack. Fixed on both counts: the batch asks only about
pids that exist and reads output whatever the exit status, and liveness now
reads "unreadable" as *alive*. `stop`'s check before it signals a pid stays
strict, because there "cannot tell" has to mean "do not".

**The menu bar could never stop an app.** `stop` refuses to signal an app
whose entry has no process identity, since a bare pid may belong to someone
else by then. The CLI recorded spawned apps' pids without one. The function
written to record both, `recordAppPids`, was never called. So Stop has refused
every app on every run since sessions arrived. `recordAppSpawn` now records
the identity at spawn, and a test stops a real process through `handleStop`.
