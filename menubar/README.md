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

## Remote environments

Choose **Copy connection token** in the Remote environments key menu. Store it as `BUNCARGO_CONNECT_TOKENS` on a server or cloud agent, mark the intended apps/services `expose: true`, and run `buncargo dev`. Multiple recipient tokens are a JSON array. No VPN setup or sharing flag is required.

Remote environments appear by project and branch/worktree, with the same row presentation as local runs. Open creates an authenticated local browser proxy. Connect creates a loopback TCP listener and copies its address; use your own database credentials. PostgreSQL can also open in TablePlus. Disconnect closes the local listener; Revoke withdraws this recipient's access to the remote session without stopping the server.

The key menu provides token rotation and revoke-all-and-rotate. Rotation affects new registrations; existing sessions retain their grants unless revoked. Device credentials stay in a private local state file owned by the CLI. The app invokes the CLI for setup, discovery and connection actions; remote data never supplies executable paths.

Discovery refreshes every 15 seconds and when the menu opens, with failure backoff. Expired/disconnected entries disable actions. A publisher whose relay is unavailable shows Connecting until it reconnects. Private streams use outbound WebSockets through the stable `connect.hanskristoffer.dk` relay, so new worktrees need no tunnel installation or DNS allocation. A separate CLI helper keeps streams alive when the menu closes and revalidates access. The CLI and app must both be updated to builds containing this feature.

## Build from source

Needs the Xcode command line tools (Swift 6, macOS 14+).

```bash
bash menubar/scripts/install.sh     # build, install to /Applications, open
bash menubar/scripts/package.sh     # build the .app bundle only
swift test --package-path menubar   # remote store and shared directory contract tests (from repo root)
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

Releases happen by merging the Release Please PR (`docs/release-flow-plan.md`);
a squash-merged PR that touches `menubar/` proposes the next `bar-v<version>`,
bumping `version.txt` and `CHANGELOG.md` here. On merge, `release.yml` tags and
calls `.github/workflows/release-menubar.yml`, which builds a universal bundle,
smoke-tests it, and uploads `BuncargoBar-<version>.zip` plus a `.sha256` to the
release. A schema bump touches both `src/` and `menubar/`, so one release PR
ships both sides. `buncargo bar install` downloads exactly those assets. Signing and
notarization happen only when the Apple secrets are configured; without them the
ad-hoc signed bundle ships and the installer clears the quarantine attribute.
