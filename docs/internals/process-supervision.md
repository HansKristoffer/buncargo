# Process supervision

`src/core/process/` is command execution (`exec.ts`), the dev-server spawner (`dev-servers.ts`:
waves, ownership, captures, restarts) and the single-app spawn it drives (`app-process.ts`: shell,
prefixed output, the `script` tee, prebuild), port ownership and kill classification
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

## Ordering and output capture

`start-order.ts` turns `startAfter` into layers inside the two tunnel phases (without `startAfter`
a phase is one layer, the old wave).

`output-capture.ts` matches complete lines only, because a URL cut off mid-chunk is still a valid
URL. For the same reason it joins rows an app wrapped itself (Ink at a narrow pane's width) back
onto a line ending in a URL (`joinWrappedUrls`), holds a trailing `\r` for its `\n`, never takes
an incomplete `publicUrl` (`looksLikeCompleteUrl`: a dotted host with a TLD, not stopping inside
`trycloudflare.com`), and lets a URL ending the newest line wait for the row that may continue
it. The attached app is teed through `script` when stdin is a TTY, else through pipes.
`ProcessOwner.retire` replaces a child for `restartOn` without its exit counting as a crash.

## Failure and non-essential apps

`keepOthersOnFailure` (on in `dev` unless `options.onAppFailure: "stop-run"`) waits for each app of
a wave on its own, then stops and parks the ones that never came up by adding them to the same
`optional` set an `essential: false` app is in, so restart, the TUI and the registry need nothing
new. Whether the run fails is decided before anything is parked: when a later app `startAfter`s a
failed one, or nothing else is left.

`port-drift.ts` races every wave's readiness: an app whose process tree listens on another port
while its own is held by something else fails at once. It connects to the assigned port and never
binds it, because a probe that bound it could push the booting app off.

`essential: false` is `ProcessOwner.optional`: the app's exit parks it instead of aborting,
`owner.wait()` keeps waiting while anything is parked, and its readiness never gates a wave (it is
health-checked on the side, also after every restart). Each side check belongs to one process:
exit or replacement aborts it, and `markReady` only promotes a `starting` app, so a late check
cannot report a dead or replaced app ready.

`AppSupervision.restart` runs restarts of one app one after another (a request before the first
has begun joins it): two at once would both retire the same child and the second replacement fails
on the port. In the run registry a new pid is a new process generation, the one update allowed to
take a `stopped`/`failed` app back to `starting`.

A non-essential worker that dies while its ownership is being claimed (before or while the claim
is written) is handed to the supervisor anyway (`spawnOwnedWorker`'s `allowEarlyExit`), with no
claim left behind and its process group stopped first, since what it spawned would otherwise run
unowned. `ProcessOwner.register` reports the exit of a child that is already gone, which never
emits `exit` to it: otherwise a crash at boot failed the whole start, the one thing
`essential: false` promises not to do.

`startDevServers` records an exit the moment it is seen (`exited`), not when it is shown: the
verdict waits for the app's last screen to flush, and in between a readiness check would otherwise
promote the dead process.

## Watching files and ready-by-output

`app-watch.ts` is the `watch` config: one recursive `fs.watch` (FSEvents) per path, debounced,
restarting through `restartApp`, which already retires, waits and serializes. Watchers start after
the waves, so a save mid-start cannot race readiness, and only for apps this run spawned.

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
