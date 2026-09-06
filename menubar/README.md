# BuncargoBar

A macOS menu bar app that lists the `buncargo dev` runs active on this machine:
every project, every worktree, every app and service, with one click to open the
main app, copy a connection string, open a database in TablePlus, open an Expo
app in that checkout's own iOS simulator, or stop something.

![BuncargoBar showing a running project, its apps and services](../buncargo-topbar.png)

When a run's main app comes up, the app posts a notification naming the project
and branch, with **Open** and **Copy URL** buttons for that app's URL. macOS
asks for notification permission the first time; runs already up when the app
launches stay quiet.

It reads `~/.buncargo/runs.json`, which `buncargo dev` writes and keeps current.
No Docker call, no config load, no git — the app is a reader, and every action
that changes something shells out to `buncargo stop`.

## Install and update

```bash
bunx buncargo bar install
bunx buncargo bar update
```

`buncargo dev` also offers it once, the first time it runs on a Mac that does
not have it. Answering `n` there means it never asks again; `buncargo bar reset`
undoes that.

The CLI is the only updater — the app has no update checker of its own, so the
two can never race on the same bundle. After every `buncargo dev`, in the
background:

- **The app cannot read this CLI's `runs.json`** (its `BuncargoRegistryVersion`
  is behind) → updated automatically, because its menu is empty until it is.
- **A newer release exists** → one hint line, once per release.

Answers are cached in `~/.buncargo/bar-check.json` (24 h, 1 h when an update is
required) so `dev` does not spend GitHub's anonymous rate limit. `BUNCARGO_BAR=0`
and CI turn the whole thing off.

## Build from source

Needs the Xcode command line tools (Swift 6, macOS 14+).

```bash
bash menubar/scripts/install.sh     # build, install to /Applications, open
bash menubar/scripts/package.sh     # build the .app bundle only
bash menubar/scripts/launch.sh      # open an installed copy
```

## Troubleshooting

```bash
/Applications/BuncargoBar.app/Contents/MacOS/BuncargoBar --status
```

Prints one line per run and exits. If this says `no active runs` while
`buncargo runs` shows some, the two are reading different registries — check
`HOME`.

| Problem | Fix |
| --- | --- |
| Menu is empty | Run `buncargo runs`. If that is empty too, no run has published itself yet. |
| App will not open from Finder | `bash menubar/scripts/launch.sh` clears the quarantine flag. |
| No start notifications | System Settings → Notifications → BuncargoBar. Only the *first* run of a workspace notifies; restarting it notifies again. |
| No TablePlus button | Only shown when TablePlus is installed, and only for database services. |
| An app shows a named `https://` URL that 404s | The hosts daemon is not serving it; `buncargo hosts status`. |
| Menu says the app is too old | `buncargo bar update`. The registry schema moved past this build; `buncargo bar status` prints both versions. |

## Layout

```
Sources/BuncargoBar/
  App.swift          # MenuBarExtra scene, --status mode, stop confirmations
  RunRegistry.swift  # runs.json v1 model, supported version, liveness, grouping
  RunStore.swift     # directory watch + 5s poll, published state
  Views.swift        # rows, hover detail panel, status dots
  Actions.swift      # open/copy/TablePlus, and `buncargo stop` / `buncargo sim` invocation
  Notifications.swift # "workspace started" notifications, Open/Copy actions
fixtures/
  runs.v1.json       # schema contract, checked by Swift and TypeScript tests
scripts/
  package.sh         # build + bundle (VERSION/BUILD_NUMBER from the env)
  install.sh         # package --install --open
  launch.sh          # open, clearing quarantine
  smoke-test.sh      # --status and --selftest against the fixture; runs in CI
```

## Releasing

**A CLI release that bumps `REGISTRY_VERSION` must be preceded by a `bar-v*`
release built from the same commit.** Otherwise every installed app is
unreadable until the app release lands — the CLI refuses to install a release
that still cannot decode its registry, so the failure is a clear message rather
than a broken install, but the menus stay empty in the meantime.

`package.sh` stamps the schema version into `Info.plist` from
`fixtures/runs.v1.json`, and the smoke test fails if the plist and the Swift
decoder disagree, so bumping the schema is a three-file change the CI catches:
`core/run-registry.ts`, the fixture, and `RunRegistry.supportedVersion`.

Tag `bar-v<version>`; `.github/workflows/release-menubar.yml` builds a universal
bundle, smoke-tests it, and publishes `BuncargoBar-<version>.zip` plus a
`.sha256`. `buncargo bar install` downloads exactly those assets. Signing and
notarization happen only when the Apple secrets are configured; without them the
ad-hoc signed bundle ships and the installer clears the quarantine attribute.
