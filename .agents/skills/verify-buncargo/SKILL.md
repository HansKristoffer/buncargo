---
name: verify-buncargo
description: Verify a buncargo change in a real run of the CLI built from this checkout, against the example playground's real containers and dev servers. Use when a change is about what an actual process, container, terminal or named host does, and a hermetic test cannot show it.
---

# Verify buncargo in a real run

A real run claims ports, containers and hostnames on the developer's machine,
beside their own projects. Keep it to this checkout's playground, and leave the
machine as you found it.

## Start

Work from `example/playground`. It imports `../../src`, so the CLI runs this
checkout's source with no build:

```sh
cd example/playground
bun install                 # first time in this worktree only
bun ../../src/cli/bin.ts dev --detach --no-hosts
```

- `--detach` returns once every app has settled; exit 1 names the apps that did
  not come up, with their logs in `.buncargo/logs/`.
- Drop `--no-hosts` only when the change is about named hosts. Hosts need the
  developer's installed hosts service; never install it or run `sudo` yourself.
- Add `--apps=api` to start one app, `--tui` only when you are testing the TUI
  under a real pseudo-terminal.

## Observe

Use buncargo's own readers rather than `sleep`, `curl` loops or `docker` calls:

- `bun ../../src/cli/bin.ts wait --app=api` blocks until healthy (0), failed (1)
  or timed out (2).
- `bun ../../src/cli/bin.ts status --json` gives ports, containers, URLs and app
  states as one object.
- `bun ../../src/cli/bin.ts url api`, `env --get DATABASE_URL`,
  `logs api --errors`.
- `bun ../../src/cli/bin.ts sql -c "select 1" --json` reaches this checkout's
  Postgres.

The change is verified when the behavior it promises is visible in one of
these outputs. Quote that output in your report.

## Stop

```sh
bun ../../src/cli/bin.ts stop --all
```

Run this before you finish, even after a failure, and confirm with
`status --json` that this checkout's run is gone. Stop nothing you did not
start: no `--down --all`, no `docker rm`, no killing by name. Volumes stay;
the playground's database is meant to survive.
