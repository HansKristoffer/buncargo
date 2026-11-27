# Process supervision

`src/core/process/` is command execution (`exec.ts`), the dev-server spawner (`dev-servers.ts`:
waves, ownership, captures, restarts) and the single-app spawn it drives (`app-process.ts`: shell,
prefixed output, the attached app's terminal, prebuild), port ownership and kill classification
(`port-owner.ts`), PID lifecycle (`lifecycle.ts`) and production builds (`build.ts`), re-exported
from `process/index.ts`.

## Liveness

`isProcessAlive` counts `EPERM` as alive. It is the ordinary answer when an unelevated CLI asks
about the root hosts daemon, and only `ESRCH` means gone. Reading `EPERM` as dead had a dev run
break the daemon's registry lock the moment it held one (the exact race the lock exists to
prevent) and prune every route the daemon owned.

`detached-app.ts` uses the shared port snapshot on a server's exit zero to adopt an out-of-group
listener with its birth identity; supervision republishes its pid and cleans it up with the
session. Astro foreground markers default beneath app overrides.

buncargo's own long-lived tools (frpc, cloudflared) run under `child-guard.ts`: a small parent
that stops the tool when the stdin buncargo holds reaches EOF. That is the only cleanup a SIGKILL
leaves us, and a cloudflared spawned detached on its own outlived a hard-killed `dev --expose`
with its public tunnel still open.

## Ordering and output capture

`start-order.ts` turns `startAfter` into layers inside the tunnel phases (without `startAfter`
a phase is one layer, the old wave). When a blocking `AfterAppsTask` (such as `seed.afterApps`
with `beforeApps !== false`) is supplied, `planSpawnOrder` separates the barrier apps and their
transitive `startAfter` dependencies into `beforeBarrier` waves so `dev-servers.ts` can await them,
run the task, and only then spawn `beforeTunnels` and `afterTunnels`. When `beforeOtherApps` is
`false`, all apps follow normal waves while the task starts as soon as its `afterApps` report ready
and is joined before `onReady`.

`output-capture.ts` matches complete lines only, because a URL cut off mid-chunk is still a valid
URL. For the same reason it joins rows an app wrapped itself (Ink at a narrow pane's width) back
onto a line ending in a URL (`joinWrappedUrls`), holds a trailing `\r` for its `\n`, never takes
an incomplete `publicUrl` (`looksLikeCompleteUrl`: a dotted host with a TLD, not stopping inside
`trycloudflare.com`), and lets a URL ending the newest line wait for the row that may continue
it. Piped bytes become lines only through `line-splitter.ts`: a streaming decoder (a character cut at a chunk
boundary used to become U+FFFD) and a 64 KiB cap per line.
`AppSupervision.retire` replaces a child for `restartOn` without its exit counting as a crash.

## One lifecycle per app

`app-lifecycle.ts` is an app's life as a value (`AppLife`: phase `starting | ready | restarting |
reused | down`, a standing `essential | optional | probation | parked`, a generation, the pid, and
how it ended) and a pure `transition(life, event)`. `AppSupervision` is the one owner of each app's
spec, process and life, applies every step and reports it once through `onPhase`
(`onAppPhase` outside): the rows (`RunOutput` feeds stream mode, the TUI and the log files) and
the run registry (`appRowEvents`) read the same value. Before this, an essential app on probation
that exited 0 was `failed` in the registry and `stopped (exit 0)` on its row, judged by two formulas
at two times. An exit's verdict is decided by `transition` at the exit: `failed` for an app gone
before its readiness check passed (unless the run is ending), else by the exit code, with a spared
(`optional`, `parked`) worker exiting 0 only stopped. An app with no check (a worker,
`healthEndpoint: false` without `readyWhen`) is read by its code, so a one-shot that exits 0 has
stopped. `afterExit` says what the exit does to the run, and `runVerdict` whether going on without
the failed essential apps ends it. Errors that end a run over one app are `AppFailure { app, kind }`,
which `run-failure.ts` reads instead of searching the message. The supervisor registers no signal
handlers: it follows the `AbortSignal` it is given, and `startDevServers` turns SIGINT, SIGTERM and
SIGHUP into one.

## Failure and non-essential apps

`keepOthersOnFailure` (on in `dev` unless `options.onAppFailure: "stop-run"`) waits for each app of
a wave on its own, then stops and parks the ones that never came up, crashed at boot included:
until it is ready, each essential app of the wave is on probation, so its exit leaves the decision
to the wave instead of ending the run. The attached app is never on probation: quitting it ends the
run. Every process has one readiness wait (`appReady`: `readyWhen`, then the caller's
`waitForHealth` for that one app), shared by the wave, the sparing of the others and the side
checks, and the app is marked ready the moment it resolves: before, the sparing pass reported
nothing until the slowest app of the wave settled, so `buncargo wait --app=api` waited out `web`'s
whole timeout. Probation ends when the wave's waits settle, not at a deadline: a worker or
`healthEndpoint: false` app without `readyWhen` is ready once the rest of its wave is, so it is
spared only while the wave comes up, and its crash after that ends the run. A boot window was left
out on purpose: either every wave with a worker waits it out, or a crash inside it needs a verdict
after the wave moved on. `AppSupervision.fail` is the one path for an app that did not come up or
could not be restarted, at start, after a side check and after a restart: it decides with
`runVerdict` (a later app `startAfter`s a failed one, an `AfterAppsTask` requires it via
`RequiredByTask`, or nothing else is left) before anything is
parked, so a row on probation offers no restart until then, and a run about to fail never says the
rest keeps going. A parked app is spared like an `essential: false` one until a ready process makes
it essential again: from then its crash ends the run. A reused app (another process serves its
port) that fails its check is reported failed and left running, since this run can neither stop
nor restart it.

`port-drift.ts` watches every wave (one watcher per wave, or per side check, over whichever of its
apps are still coming up, one listener snapshot a second): an app whose process tree listens on
another port while its own is held by something else fails at once. It connects to the assigned
port and never binds it, because a probe that bound it could push the booting app off.

An `essential: false` app's exit never ends the run; `AppSupervision.wait()` keeps waiting while
a spared app is down, and its readiness never gates a wave (it is checked on the side, also after
every restart). Each readiness wait belongs to one process generation: exit or replacement aborts
it, and `ready(name, generation)` only promotes that generation while it is coming up, so a late
check cannot report a dead or replaced app ready. A side check that fails goes through
`AppSupervision.fail`, so no row stays `starting`. The same holds for what an exit shows: an exit's
row is shown after the app's last screen flushes, read from the app's life then (parking may have
said more), and dropped once a newer generation exists.

`AppSupervision.restart` runs restarts of one app one after another (a request before the first
has begun joins it): two at once would both retire the same child and the second replacement fails
on the port. In the run registry a new pid is a new process generation, the one update allowed to
take a `stopped`/`failed` app back to `starting`. A restart that retires the old process and cannot
spawn its replacement fails the app (`kind: "restart"`): a retired process's exit is never
reported, so nothing else would move the app's row and registry entry off `restarting`. It is
parked when the run spares it, otherwise the end of the run, which would else wait on an app that
is gone. The session keeps the app's last pid, so `stop()` still finds it. A row only says `starting` once a restart has begun, so a restart asked for after the run
ended changes nothing. A restart that retires a launcher while its exit is still looking for the
server it detached waits for that lookup and stops the server, which would otherwise be adopted
beside the replacement. An adopted server is watched with `kill(pid, 0)`; its identity is read only
before it is signalled.

A non-essential worker that dies while its ownership is being claimed (before or while the claim
is written) is handed to the supervisor anyway (`spawnOwnedWorker`'s `allowEarlyExit`), with no
claim left behind and its process group stopped first, since what it spawned would otherwise run
unowned. `AppSupervision.register` reports the exit of a child that is already gone, which never
emits `exit` to it: otherwise a crash at boot failed the whole start, the one thing
`essential: false` promises not to do.

## Apps started after startup

A session's controls (`SessionControls`, handed to `onReadyWatch` once the waves settle) include
`start(apps)`: apps the run left out at startup join it. `AppSupervision.add` supervises them, as
`optional`, since the run went on without them; their secrets load before any is added, so a
missing one takes on none. Each row reads `starting` from the moment it is added, before it
spawns. They spawn in the background, one `startAfter` layer at a time, each layer ready before
the next; the last is checked on the side like a restart. One that does not come up is parked,
and every app still to spawn after it is failed with no process (generation 0), naming it; an
error nothing expected (a watcher the OS refuses is only announced) fails the late apps, never
the run. A restart of such an app is its first spawn (`restartApp` sees generation 0 and
`down`), one at a time per app (`firstSpawns`), so fixing the prerequisite and pressing `r`
brings it up once.

`pipeline.ts` wraps it as `LateStart` (`onLateStart`), refused once the session is ending (its
entry is being released, and a claim would publish it again): the apps' leases and rows first (one more
`claimApps`, which lists the reused apps again, or the entry would drop them), the egress proxy if
the run had none and one of them is guarded, then the session. A lease refusal, or a start that
throws, gives the leases back and publishes the entry again without the rows, or `wait` and `ls`
read them as starting for good. `cli/dev-late-start.ts` decides what a request means, one request
at a time (`bindLateStarts`), so a second `r` during a first start's claim finds the app part of
the run and answers that it is already starting: the app with its `requiredApps` the run has not
started, all `essential: false` (so a held lease skips rather than throws), refused when it needs
a service the run did not start, since adding containers to a running stack is a new start, or
when a `preflight` step of theirs the start did not run fails without a terminal
(`runLatePreflight`: a login cannot be asked for over the TUI). Their ports are classified first,
as startup's are (`servedElsewhere`, `classifyCliApps`): spawning skips straight to
`prepareAppPort`, which kills a holder under the checkout, so without it a late start killed the
same app running in another run of the checkout. The app itself answering elsewhere is refused; a
required app answering elsewhere is used there; a port held by something else refuses it.
Reactive tasks are selected at startup and do not grow with it, and the link watcher is armed at
startup only: a late app's reactive links restart it only when a startup app already armed it.

## Stop grace

Every SIGTERM an app gets is followed by SIGKILL after its `stopGraceMs` (`AppSupervision.graceFor`,
default the session's `shutdownGraceMs`): on stop, restart, retire and the detached-adoption path
alike, because an app that saves data on exit (the Firebase emulators' export) loses it to the
first path that kills it early. The paths that stop an app by its port (`killPortOwner`: the
takeover, a leftover app that fails its health check, `stop` of a reused app) pass it as their
timeout too. `runs.json` records the grace, so `buncargo stop <app>` waits as long, and stopping a
whole run waits 5 s plus the longest one before killing the `dev` process, which is still stopping
its apps.

## Watching files and ready-by-output

`app-watch.ts` is the `watch` config: one recursive `fs.watch` (FSEvents) per path, debounced,
restarting through `restartApp`, which already retires, waits and serializes. Watchers start after
the waves, so a save mid-start cannot race readiness, and only for apps this run spawned.

`reactive-tasks.ts` (`ReactiveTaskRunner`) drives finite one-shot tasks configured with
`onAppReady` or `watch`: single-flight with at most one coalesced follow-up run, non-fatal on
failure (reporting `detail: "exit <n>"` and `rerunCommand: "buncargo run <name>"` into `RunOutput`
and `.buncargo/logs/<run>/<name>.log` without ending the dev session), triggered on initial app
readiness and every restart via `AppSupervision`'s `onPhase`, on watched file changes via `watchApp`
(skipped under `--no-watch`), and manually via `output.controls.restart(taskName)` (TUI `r`).
`signal-tree.ts` and `find-detached-app.ts` stay separated from `port-owner.ts` and
`detached-app.ts` so `terminate.ts` and `exec.ts` never pull container runtimes into the
config-authoring entry (`src/index.ts`).

`readyWhen` is matched by a scanner created per spawn (`watchForReady`), not through `captures`,
whose scanner reports a value only when it changes and would never see the line again after a
restart; `waitForDevServers` skips those apps and `waitForPrinted` runs before the wave's health
wait.

## Exclusive leases

`core/leases.ts`: exclusive leases in `~/.buncargo/leases.json`, held by the `dev` process and free
once it is gone. Acquisition and `transferLease` share a per-key gate; transfer checks the observed
holder before stopping and again before writing. The registry lock is never held during stop, so
the old run can release its leases. `cli/dev-leases.ts` takes over via `stop.ts`'s `stopTarget`,
requiring a successful stop and refusing a starting app without a pid. Declined, it skips an
`essential: false` app (returned, dropped from the spawn set before the summary and banner, and
repeated into the TUI's Overview as events, because the TUI hides the scrollback) and refuses an
essential one. Every refusal names the holder's checkout path and `--takeover`: a run that quietly
started without the Shopify CLI was the bug.

A library `start()` takes the same leases through `environment/app-leases.ts`, for its session,
and can neither prompt nor take over: it skips an `essential: false` app with a warning and throws
for an essential one. `core/app-leases.ts` holds what both say about a holder. A start that fails
after taking leases gives back only the ones it took (`releaseLeases` with `keys`), since an
earlier `start()` of the same environment may still run an app holding another; `stop()` gives
back the rest.
