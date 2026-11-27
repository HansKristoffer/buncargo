# TUI and app output

## One feed per app

`src/core/process/run-output.ts` is the one text feed per app behind stream mode, the TUI Overview
and `.buncargo/logs/<run>/<app>.log` (`app-logs.ts`: buffered, capped, last ten runs). Apps print
into it; the supervisor reports `state` and `capture`. `startDevServers` takes it as
`options.output`; without one it prints stream mode itself, so library callers are unchanged. A
stream-mode attached app's output is fed in marked `echoed`: logged, not printed again. Run events
reach stream mode only when they are `announce`d (a restart, a pid, a warning about the run): the
caller says once what a line is, and each view decides how to show it, instead of the supervisor
checking which view is open and printing a second copy itself.

Whoever creates an output closes it, and awaits `close()` before unsubscribing a view: an app's
last screen reaches the feed only once xterm has parsed it, so a view gone by then loses the app's
last words.

`src/cli/dev-output.ts` decides where a dev run's app output goes: the TUI (a terminal, unless
`--no-tui`) or stream mode, never both, since two writers on one screen is the garbling the TUI exists to end.
Both write the log files and answer `buncargo restart` (`restart-requests.ts`: a request file
watched via `fs.watch` with a 30 s backstop timer that drops to a 2 s poll if `fs.watch` fails, not a signal; SIGUSR2 to a run from an older
buncargo, which has no handler, would kill it). `view.start()` runs after every prompt and the
banner; `view.stop()` runs before teardown so its messages land on the user's own screen.

## Pseudo-terminals

A `RunOutput` is made with `terminals: "pty"` (the TUI) or `"pipe"` (stream mode), so nothing
asks a view which one it is. Under `pty` every app spawns as a `PtyApp` (`pty-app.ts`: `Bun.spawn({ terminal })`, a
session leader so `kill(-pid)` still reaches the group, `exit` reported with Node's
`(null, signal)` arguments) into an `AppScreen` (`app-screen.ts`: `@xterm/headless`) that survives
restarts. An attached app with no TTY also runs as a `PtyApp`, which is what lets Expo start under
an agent and `send` reach it. In stream mode the attached app on a real terminal is a `PtyApp` too,
passed through: its bytes go to our stdout unchanged, our stdin (raw while it runs) and size go to
it, and its lines are fed `echoed`. It used to run under `script`, whose child leads a session of
its own, so the stop ladder's `kill(-pid)` reached only `script`, and a server that ignored the
hangup outlived `buncargo stop`.

Bun up to 1.4.3 hangs for good on macOS inside `Bun.spawn({ terminal })`, past any test timeout,
when the child prints and exits before the call returns (oven-sh/bun#45300). `PtyApp` makes its
child wait until the spawn has returned; spawn any terminal child that can exit at once through it.

`AppScreen` turns a screen back into lines by holding back the rows a recent redraw reached (an Ink
footer) and re-sending a rewritten row only when its text changed; the first frame of a live footer
cannot be told from plain lines and can appear once. Row numbers move when the scrollback trims or
`ESC[3J` clears it: a marker in the scrollback follows trims (it sits above the screen because
erasing the screen disposes markers too), `ESC[3J` is counted by its own handler, and a marker
trimmed away means every row still in the buffer is new. A logical line still wrapping onto the
cursor row is not committed yet.

## The TUI

`src/cli/tui/render.ts` is pure (every row exactly the width asked for, so frames diff row by row)
and `run-tui.ts` is the controller.

- Each app's virtual screen keeps 3,000 lines of scrollback (`SCREEN_SCROLLBACK` in `app-screen.ts`,
  down from 10,000) to bound multi-app heap while full rotated logs live on disk for `$PAGER` (`l`).
- Frames wrap non-empty row diffs in DEC Mode 2026 synchronized output (`\x1b[?2026h` / `\x1b[?2026l`)
  to prevent flicker/tearing during scrolling and resizing. Background app lines skip redrawing an
  unrelated active app pane unless a sidebar unread badge flips, and terminal resize reflows across
  child screens are debounced by 60 ms.
- `layoutSidebar` computes the sidebar's rendered rows, sticky scroll window, `Tasks` section
  divider, and mouse hit-testing in one pass so narrow terminals never clip state/`!` badges and
  short terminals keep the selected row clickable and in view. `b` / `[` collapses the sidebar.
- While it owns the terminal it captures `process.stdout/stderr.write` and `console.*` into the
  Overview as `buncargo` lines. Bun's `console.log` does not go through `process.stdout.write`, so
  patching only the stream misses it. The captured `write` honors Writable callbacks, or a hook
  awaiting one hangs.
- It restores raw mode, the alternate screen and the cursor on `stop()`, which also runs from a
  process `exit` handler (sync `writeSync`) and from `uncaughtExceptionMonitor`, before Bun prints
  the error: restored at exit, leaving the alternate screen would erase it. Bun has no monitor
  event for a rejection, so an `unhandledRejection` handler restores and rethrows it (still
  printed, still exit 1). `run-tui.test.ts` checks all of it under a real pty with `stty`.
- Input is read as keys, not chunks: a sequence cut off at a chunk's end waits for the rest, and an
  Esc nothing follows within 30ms is the Esc key (chunks split anywhere, so a one-byte chunk proves
  nothing). Interact mode forwards every key except Esc and `Ctrl-]`, either of which leaves it;
  `q`/`Ctrl-C` outside it sends the run SIGINT, the same shutdown path as a terminal Ctrl-C.
  App-declared actions (`AppConfig.actions`, e.g. Shopify `p` and `g`) take precedence over
  convenience keys (`0`-`9`, `s`, `c`, `y`, `w`, `b`, `i`, `g`, `G`, `n`, `N`).
- Overview `e` uses one `createErrorFilter({ includeWarnings: true })` per app so structured error
  blocks and stack frames stay attached, matching `buncargo logs --errors`. `/` runs live search
  in both Overview (filter + highlight) and app panes (buffer scan + `n`/`N` match jumping +
  highlight). `w` toggles O(height) backward soft-wrapping in Overview, `c` clears the current
  pane (`AppScreen.clear()` for apps), `y` copies the app URL, and `i`/`?` opens a scrollable
  environment-info and keybinding overlay.
- `s` toggles stop/start on an owned app via `AppSupervision.stopApp` (retires the child and parks
  the app without ending the run) or cancels a running reactive task via `ReactiveTaskRunner.cancel`.
  `r` and `s` await control outcomes and report reused/failed apps instead of swallowing rejections;
  transient footer messages auto-clear after 3 s.
- While the pager (`l`) runs, the TUI stops reading stdin entirely and only takes the screen back
  if it is still active; `stop()` kills an open pager. In Overview, `l` merges the run's `.log`
  files chronologically into a temp file for `$PAGER` (falling back to opening the directory when
  empty). The pager has the terminal in cooked mode,
  so Ctrl-C there is a SIGINT to the whole process group, run included: the run's SIGINT listeners
  are moved aside until the pager exits, and the signal closes the pager instead (Bun calls the
  listeners directly, so wrapping `process.emit` does not intercept it). Adding and removing
  SIGINT listeners is wrapped meanwhile: one added under the pager is held aside too, or the
  Ctrl-C that closes the pager would fire it, and one removed while held aside (the run ended
  under the pager) would otherwise be put back when the pager closes.
- Reactive task panes (`taskNames` in `RunTuiOptions`) sit in a `Tasks` section in the sidebar with
  their `detail` label (`idle`, `running`, `ok`, `stopped`, `exit <n>`), show `r run` (and `s stop`
  while running) in the footer, ignore `Enter` (no interact mode), and route `r`/`s` through
  `controls.restart`/`controls.stop`.
- Apps the run left out (`leftOut` in `RunTuiOptions`, from `leftOutApps` in `run-cli.ts`) sit
  below active apps (above `Tasks`) as `off` until they have a state: dimmed name, no URL, no
  interact mode, `r start` in the footer, routed through `output.startApp` on `r` or `s` once
  startup settles (before that, starting says so and starts nothing). Async outcomes flash in the
  footer via `flash()` (auto-clearing after 3 s); a refusal's first line goes there and the whole
  of it to the Overview. `openDevOutput` passes `allApps` to `appActions` so late-started apps
  still gain their declared footer actions once their captures arrive, and removes an app from
  `pendingLeftOut` once it leaves its initial `starting` phase so subsequent `buncargo restart`
  calls route through `controls.restart`. Binding `startApp` announces the left-out apps once
  (`leftOutNotice`), so the Overview says what `r` can start.
- Mouse reporting (SGR with drags, `?1000`/`?1002`/`?1006`) is part of entering and leaving the
  screen, so every restore path turns it off too. The wheel scrolls the shown pane, also in
  interact mode, where mouse reports are stripped rather than typed into an app that never asked
  for them. A scrolled-back app pane is held by a marker on its top row, so it stays on its text
  while the app prints; a key typed into the app returns it to the bottom.

## Selection

Because the terminal cannot select while it reports the mouse, the TUI selects itself, like tmux.
Each end of a drag is held by what it points at: the Overview `OutputLine`, or an xterm marker on
the app's buffer row (a plain row on the alternate screen, which takes no markers). So it survives
scrolling and trimming, and ends instead of attaching to other text once its line is dropped,
cleared, or the app switches screens. A release where the pointer last was keeps the head on the
text it was on. It is drawn reversed over the row's own styles (concealed text stays concealed),
and on release copies whole lines (`overviewPlainLine`, not the cut-off row) through `clipboard.ts`
(`pbcopy`/`wl-copy`/`xclip`, else OSC 52; tests inject `copy` so they never touch the real
clipboard).

Rows the terminal wrapped are joined from xterm's `isWrapped`. Rows an app wrapped itself (Ink
breaks at the pane's width with real newlines) look like separate lines, so `wrapJoint` guesses
from widths, and a wrong guess merges two lines. It leans toward keeping a break, and never joins
after a line the terminal had to wrap, since that app does not wrap its own output. The capture
scanner's `joinWrappedUrls` is not used here: it joins `http://localhost:3000` and a following
`ready`, harmless for a capture but corrupting for a copy.
