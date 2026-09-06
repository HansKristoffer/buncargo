# Keeping BuncargoBar current with the CLI

> **Status (2026-09-06): built.** All four steps shipped: the
> `BuncargoRegistryVersion` contract, `updateBar()`/`buncargo bar update`, the
> background check in `dev` (`core/bar-update.ts` + `cli/bar-offer.ts`), and the
> app's outdated-registry message. Deviations from the plan below are marked
> **[changed]**.

## The gap

`buncargo dev` installs BuncargoBar once and never touches it again. Three
places say the app "checks for its own updates" (`core/menubar.ts`,
`cli/commands/bar.ts`, `release-menubar.yml`); it does not — `menubar/Sources`
has no network code at all. An installed bar is frozen at whatever version was
current the day it was installed, while the CLI ships via npm every few days.

Today that is survivable because `runs.json` is still v1 and every field the CLI
has added since is optional on the Swift side. The day the registry needs a v2,
every installed app silently shows "No buncargo environments running", which
looks like a broken `dev`, not an old app.

## Decision: the CLI is the only updater

Not an in-app updater, not Sparkle.

- The CLI already owns download, checksum, `ditto`, quarantine clearing and the
  `bar.json` manifest. An in-app checker would be a second copy of that in
  Swift, and Sparkle needs a signing key and an appcast we would also have to
  publish.
- The stated reason for "the CLI never upgrades" was two updaters racing on one
  bundle. The fix is one updater, and the CLI is the one that already exists.
- The CLI is the side that *changes*. It knows the exact moment compatibility
  breaks: when it starts writing something the app cannot read.
- npm has no post-install hook we can trust (`bunx` runs fresh every time), so
  `buncargo dev` — the one thing every user runs, constantly — is the hook.

## Compatibility contract: "supports the installed CLI"

The coupling is exactly one number: `REGISTRY_VERSION` in `core/run-registry.ts`
(currently `1`), which `RunRegistry.load()` in Swift refuses anything but.
Optional fields already degrade on both sides by design, so this is the only
break that exists.

The app declares what it reads; the CLI compares against what it writes.

1. `package.sh` stamps `BuncargoRegistryVersion` (integer) into `Info.plist`,
   sourced from `fixtures/runs.v1.json`'s `version` — the fixture is already the
   contract both test suites decode, so the app and the CLI agree on every
   commit for free.
2. The CLI reads the installed bundle's `Info.plist` — a regex over our own XML,
   no `plutil` spawn — for `CFBundleShortVersionString` and
   `BuncargoRegistryVersion` (missing → `1`, for apps built before this).
3. Two tiers:

| Installed app | Meaning | What `dev` does |
| --- | --- | --- |
| `BuncargoRegistryVersion < REGISTRY_VERSION` | cannot read this CLI's registry | **updates it**, in the background, after startup — one log line, no question |
| older semver than the latest `bar-v*` release | works, but behind | one hint line, once per new version: `BuncargoBar 0.4.0 available — buncargo bar update` |
| same or newer | fine | nothing |

The required tier is automatic because the user already opted in to the app,
the download is a few MB, and the alternative is a blank menu. Never on the
critical path: the check runs after the run is published, `void`-ed, wrapped in
try/catch, `AbortSignal.timeout(5000)` on the fetch. Startup cost on the common
path is one small JSON read (the cache) and one `Info.plist` read.

Source installs (`bar.json` says `appVersion: "source"`, local builds report
`0.1.0`) skip the semver tier — they would look permanently outdated — but the
registry tier still applies to them.

## Rate limits and cache

The GitHub API allows 60 unauthenticated requests per hour per IP; `dev` runs
far more often than that across worktrees. `~/.buncargo/bar-check.json`:

```json
{ "version": 1, "checkedAt": "…", "latest": { "version": "0.4.0", "zipUrl": "…", "checksumUrl": "…" }, "hintedVersion": "0.4.0" }
```

Fetch only when `checkedAt` is older than 24 h (registry tier: 1 h, so a
broken app is not stuck behind a day-old cache). `hintedVersion` is what keeps
the "available" line to once per release. `BUNCARGO_BAR=0` and CI disable the
check the same way they disable the offer — one knob, already documented.

## Applying an update

`installBar()` already does everything except deal with a running app.
**[changed]** It did not need a sibling `updateBar()`: install and update are
the same five steps, so `installBar({ minRegistryVersion })` is the whole thing
and `bar update` is a caller that passes the guard and prints differently.

1. `withFileLock` on the manifest, so two `dev`s starting at once (the exact
   race the old comment feared) serialise; the second one re-reads the manifest
   and finds nothing to do.
2. Remember `isBarRunning()`. Quit it (`osascript quit`, then `pkill -x` after a
   short grace) before `rm -rf`-ing the bundle; replacing a running bundle is
   what produces half-updated apps and Launch Services confusion.
3. Download, verify, extract — then **read the new bundle's `Info.plist` before
   installing it.** If its `BuncargoRegistryVersion` is still below the CLI's,
   abort with "no BuncargoBar release supports buncargo X yet" and leave the old
   app in place. This is the guard against a CLI release going out before the
   matching app release.
4. `ditto` into place, clear quarantine, write the manifest.
5. Relaunch only if it was running. A user who quit the app stays quit.

`buncargo bar update` exposes this directly; `bar install` on an installed app
is the same thing; `bar status` and `doctor` print
`BuncargoBar 0.2.0 (0.4.0 available)` from the cache.

## Failsafe in the app

If the CLI side never runs (`BUNCARGO_BAR=0`, someone else's `dev`), the app
must still not lie. `RunRegistry.load()` throws a typed
`unsupportedRegistryVersion` instead of returning `[]`, and the menu shows
"This BuncargoBar is too old for the installed buncargo — run
`buncargo bar update`". `RunStore.errorMessage` already exists for this and is
not rendered today; render it.

## Release rule

A CLI release that bumps `REGISTRY_VERSION` must be preceded by a `bar-v*`
release built from the same fixture. The existing PR `verify` job plus the TS
fixture test already guarantee the *sources* agree; the ordering is a checklist
item in `menubar/README.md` under Releasing, and step 3 above is what makes
getting it wrong a clear message instead of a broken install.

## Work

| Step | Touches | Size |
| --- | --- | --- |
| 1. Contract: stamp `BuncargoRegistryVersion`, `--status` prints it, `readInstalledBarInfo()` in `core/menubar.ts`, fix the three false comments | `package.sh`, `App.swift`, `menubar.ts` | ½ day |
| 2. `installBar({ minRegistryVersion })` + `buncargo bar update`, quit/relaunch, post-extract registry check, file lock | `menubar.ts`, `bar.ts`, `registry.ts` | ½ day |
| 3. Check in `dev`: cache file, TTLs, two tiers, background execution; pure `decideBarUpdate()` with unit tests for every row of the table | `core/bar-update.ts`, `bar-offer.ts`, `run-cli.ts` | ½ day |
| 4. App failsafe message; `bar status`/`doctor` lines; README | `RunRegistry.swift`, `App.swift`, docs | ¼ day |

Step 1 and 4's Swift half ship in the next `bar-v*` release; nothing in the CLI
depends on them being installed yet (missing plist key reads as `1`).

## Not doing

- In-app updater or Sparkle — see the decision above.
- Prompting before an update. The first-run prompt slot is for onboarding; an
  update is a log line.
- Auto-updating the CLI itself, or pinning app↔CLI semver pairs. The registry
  version is the only real coupling; pretending otherwise means bumping a
  matrix for every UI change.
- Homebrew cask. Still phase 4 of `menubar-app-plan.md`; when it lands,
  `updateBar()` defers to brew when brew owns the bundle.

## What shipped

- **Contract.** `package.sh` stamps `BuncargoRegistryVersion` from
  `fixtures/runs.v1.json`; `RunRegistry.supportedVersion` is the decoder's side;
  `smoke-test.sh` fails when the plist and the decoder disagree, and when a v99
  registry does not produce the "too old" message.
- **`core/menubar.ts`.** `readInstalledBarInfo()` / `readBundleInfo()` (regex
  over our own plist, no `plutil` spawn), `quitBar()` shared with `uninstallBar`,
  `installBar()` under `withFileLock` with the post-extract compatibility guard,
  and `relaunched` in the result.
- **`core/bar-update.ts`.** `decideBarUpdate()`, `compareVersions()`,
  `isCacheFresh()`, and the `bar-check.json` reader/writer. Pure; 11 unit tests.
- **`cli/bar-offer.ts`.** `checkMenuBarAppUpdate()`, called `void`-ed from
  `run-cli.ts` right after `publishCurrentRun`.
- **App.** `UnsupportedRegistryVersion` thrown instead of an empty list,
  `RunStore.isOutdated`, and the menu rendering `errorMessage` with
  "run `buncargo bar update`".

Verified against the real world: the installed 1.0.0 bundle reads as
`registryVersion: 1`; a simulated v2 CLI decides `update`; the hint prints once
and is then cached silent; and `installBar({ minRegistryVersion: 99 })` against
the real published release refuses **after** downloading and **before** quitting
or replacing anything — the running app was untouched.
