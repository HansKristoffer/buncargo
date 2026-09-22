<!--
TITLE: one conventional-commit line, imperative, <= 72 chars, no trailing period.

  type(scope) then a colon then the summary

  feat  -> minor   new or changed user-facing behaviour (incl. deliberate removals)
  fix   -> patch   something was broken and now works
  perf  -> patch
  feat! -> major   incompatible change (or add a breaking-change footer, see below)
  chore docs refactor test ci build style -> no release; only when nothing user-visible ships

  scope = the area, e.g. bar (menubar/, the BuncargoBar app — the release-please
  component name; never write "menubar"), hosts, secrets, connect, tunnel, vite,
  docker, release, cli.

  Which package bumps is decided by changed paths, not the scope: menubar/ bumps
  bar-v*, everything else bumps the CLI v*. Touching both bumps both — split the PR
  if that is wrong.

BODY: GitHub squashes this description into the commit message and Release Please
parses the whole thing. A fenced code block or any line shaped like a commit header
makes the parse throw, the commit is dropped, and no release is cut — with CI green.
So: plain prose and "-" bullets only. No fenced code, no headings, no tables, no
checklists, no line starting with a word followed by a colon.

Breaking change? Make the last paragraph a footer line: the words BREAKING CHANGE,
a colon, then what breaks and what to do instead.

Never mention version numbers and never edit package.json version, menubar/version.txt
or a CHANGELOG.md — the release PR owns those.

Delete this comment before opening the PR.
-->

One or two sentences on what changed and why.

- Anything non-obvious: behaviour changes, migration notes, what was left out on purpose.
