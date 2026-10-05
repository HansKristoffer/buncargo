# TUI and app output

## One feed per app

`src/core/process/run-output.ts` is the one text feed per app behind stream mode, the TUI Overview
and `.buncargo/logs/<run>/<app>.log` (`app-logs.ts`: buffered, capped, last ten runs). Apps print
into it; the supervisor reports `state` and `capture`. `startDevServers` takes it as
`options.output`; without one it prints stream mode itself, so library callers are unchanged. A
stream-mode attached app's output is fed in marked `echoed`: logged, not printed again.

`src/cli/dev-output.ts` decides where a dev run's app output goes: the TUI (`--tui` and a terminal)
or stream mode, never both, since two writers on one screen is the garbling the TUI exists to end.
Both write the log files and answer `buncargo restart` (`restart-requests.ts`: a request file the
run polls, not a signal; SIGUSR2 to a run from an older buncargo, which has no handler, would kill
it). `view.start()` runs after every prompt and the banner; `view.stop()` runs before teardown so
its messages land on the user's own screen.

## Pseudo-terminals

With `terminalSize` set every app spawns as a `PtyApp` (`pty-app.ts`: `Bun.spawn({ terminal })`, a
session leader so `kill(-pid)` still reaches the group, `exit` reported with Node's
`(null, signal)` arguments) into an `AppScreen` (`app-screen.ts`: `@xterm/headless`) that survives
restarts. An attached app with no TTY also runs as a `PtyApp`, which is what lets Expo start under
an agent and `send` reach it.

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

- While it owns the terminal it captures `process.stdout/stderr.write` and `console.*` into the
  Overview as `buncargo` lines. Bun's `console.log` does not go through `process.stdout.write`, so
  patching only the stream misses it. The captured `write` honors Writable callbacks, or a hook
  awaiting one hangs.
- It restores raw mode, the alternate screen and the cursor on `stop()` and from a process `exit`
  handler (sync `writeSync`), which is what `run-tui.test.ts` checks under a real pty with `stty`.
- Input is read as keys, not chunks: a sequence cut off at a chunk's end waits for the rest, and an
  Esc nothing follows within 30ms is the Esc key (chunks split anywhere, so a one-byte chunk proves
  nothing). Interact mode forwards every key except Esc and `Ctrl-]`, either of which leaves it;
  `q`/`Ctrl-C` outside it sends the run SIGINT, the same shutdown path as a terminal Ctrl-C.
- While the pager (`l`) runs, the TUI stops reading stdin entirely and only takes the screen back
  if it is still active; `stop()` kills an open pager.
- Mouse reporting (SGR with drags, `?1000`/`?1002`/`?1006`) is part of entering and leaving the
  screen, so every restore path turns it off too. The wheel scrolls the shown pane, also in
  interact mode, where mouse reports are stripped rather than typed into an app that never asked
  for them.

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
