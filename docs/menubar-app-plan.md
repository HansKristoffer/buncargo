# BuncargoBar: a macOS menu bar app for running environments

> **Status (2026-09-03): phases 0, 1, 2, 2b and the release workflow are built.**
> Shipped: the CI workflow, `core/state-paths.ts`, `core/prompt.ts`,
> `core/run-registry.ts` (`~/.buncargo/runs.json`), `core/primary-app.ts`,
> `core/service-identity.ts`, `buncargo runs` / `stop` / `bar`, the install
> offer in `dev`, the Swift app under `menubar/`, and
> `.github/workflows/release-menubar.yml`. Two latent bugs surfaced and were
> fixed on the way: the child supervisor lost the `close` event of an app that
> exited before supervision started (the run then hung forever with no output),
> and a signal-derived exit code was reported as a crash. Not built: phase 3
> polish (daemon health line, launch-at-login, update checker) and phase 4
> (restart, editor/terminal shortcuts, Homebrew cask, `--json` on the inspect
> commands). Deviations from the plan below are marked **[changed]**.

A menu bar app that lists every `buncargo dev` currently running on this Mac, grouped by project, with one-click access to the primary app, every app and service URL, and TablePlus for databases. Modelled on [cursorbar](https://github.com/c-johannesen/cursorbar): a small Swift 6 / SwiftUI `MenuBarExtra` app, built with SwiftPM, packaged into an `.app` by a shell script, no Xcode project.

## What it looks like

```
┌──────────────────────────────────────────┐
│ GEYSIER                                  │
│  ● Main                        [Open] ▾  │
│  ● t3code-f003056f  fix-login  [Open] ▾  │
│  ◐ t3code-4a5d8afe  starting…  [Open] ▾  │
│ LULLU                                    │
│  ● Main                        [Open] ▾  │
│──────────────────────────────────────────│
│ hosts daemon: healthy        Refresh  ⚙ │
└──────────────────────────────────────────┘
```

- **Header** is the project (`projectPrefix` from `dev.config.ts`, title-cased).
- **Row** is one checkout: `Main` for the primary checkout, otherwise the worktree name (the `gitdir` basename, which is what buncargo already uses as the worktree suffix) with the git branch as a dim subtitle.
- **Only running checkouts appear.** No run, no row; no rows in a project, no header. Empty state: "No buncargo environments running".
- **Status dot**: green when every started app reports ready, half when something is still starting, red when the run's named hosts are not being served by the daemon.
- **Open** opens the run's primary app. **▾** opens on hover (or click) a panel listing every app and service:

```
┌ t3code-f003056f ─────────────────────────────┐
│ APPS                                         │
│  ● platform  https://t3code-f003056f.lullu.localhost   ↗ ⧉ ✕ │
│  ● api       https://t3code-f003056f.api.lullu.localhost ↗ ⧉ ✕ │
│              public: https://xyz.trycloudflare.com    ↗ ⧉   │
│ SERVICES                                     │
│  ● postgres  postgresql://…:7432/lullu   ⧉  [TablePlus] ✕ │
│  ● redis     redis://localhost:7379      ⧉              ✕ │
│  ○ mailpit   stopped                                    │
│──────────────────────────────────────────────│
│ Reveal in Finder · Open in editor · Stop run │
└──────────────────────────────────────────────┘
```

`↗` opens in the browser, `⧉` copies the URL, `TablePlus` opens the connection (button only shown when TablePlus is installed), `✕` kills that one app or service. A killed entry stays in the list as `○ stopped` so it is clear it was part of this run; **Stop run** stops everything the run owns.

## The gap: nothing on disk says "what is running"

Today the app would have to reconstruct a run from four partial sources:

| Source | Has | Lacks |
| --- | --- | --- |
| `~/.buncargo/routes.json` | hostname, port, root, owner pid per app | projects without named hosts; non-HTTP services; credentials; readiness |
| `<root>/.buncargo/ports.json` | every port for the checkout | whether anything is running; URLs |
| `/tmp/<project>-<hash>-heartbeat` | owner pid, released flag | which project it belongs to without knowing the name first |
| Docker / Apple `container` labels | services and their state | apps entirely; slow to query (a CLI spawn per refresh) |

And none of them carry the primary app, the service preset (is this postgres?), or the public tunnel URL in one place. Rather than teach a Swift app to join all of that, the CLI publishes one **run registry** file, in the same style as the hosts route registry, and the menu bar app only reads that file.

## Phase 0: refactors that make the feature (and buncargo) safer to build

Each of these was found while mapping the feature onto the current code. None is required to ship the app, but skipping them means the feature adds a fourth or fifth copy of something that already exists in three places. Ordered by cost-to-payoff; the "when" column says where in the schedule each one lands.

| # | Refactor | Evidence today | Why it matters | When |
| --- | --- | --- | --- | --- |
| 1 | **CI that runs `bun test` and `bun run lint` on push and pull request** (`.github/workflows/ci.yml`, Ubuntu, Bun latest; hosts/Apple integration suites stay manual). | ~90 test files, but the only workflows are the manual cloudflared run and the manual npm publish. Nothing enforces the suite. | Every refactor below is a regression risk without it. The menubar `verify` job hangs off the same file. | First, before anything else. About an hour. |
| 2 | **One module for state paths**: `src/core/state-paths.ts` owning both `~/.buncargo/<file>` and `<root>/.buncargo/<file>`, with a single `home` / `root` override for tests. | The `~/.buncargo` helpers live in `src/core/hosts/paths.ts` under hosts-flavoured names (`getHostsStateDir`, `HOSTS_STATE_DIRNAME`) although `routes.json`, `cert-names.json` and the tools dir are machine-wide. The per-project `.buncargo` is joined by hand in `tunnel-registry.ts`, `port-allocation.ts`, `typecheck/timings.ts` and `typecheck/config-typecheck.ts`. | The feature adds `runs.json`, `bar.json`, `bar-declined` and a relocated heartbeat. Without this they become four more ad-hoc joins. Also makes the on-disk layout documentable in one place. | Before phase 1. Small, mechanical. |
| 3 | **[changed]** One prompt primitive at `src/core/prompt.ts`, not `src/cli/` — `core/hosts/onboarding.ts` is one of the two callers and core must not import from cli. With `askChoice(lines, choices)`, `isInteractive()`, and `declineMarker(name)` for read / persist / clear. Gating rules (TTY, `isCI()`, env kill switch, at most one first-run prompt per `dev`) live here, once. | `isInteractive` is defined in both `hosts/onboarding.ts` and `cli/takeover.ts`; readline prompts are hand-rolled in both. The install prompt would be the third copy. | "Never two setup questions in one run" cannot be enforced while each prompt owns its own gating. | Before phase 2b (the install prompt is written against it). |
| 4 | **One notion of the primary app**: `options.primaryApp` (or `apps.<name>.primary: true`), resolved by one `resolvePrimaryApp(config, selected)` helper; `expoApiApp`, `frontendApp` and `hosts.primaryApp` become deprecated aliases that feed the same resolver, with a validation warning. | Three knobs decide "which app is special": `expoApiApp ?? "api"` and `frontendApp ?? platform ?? web` in `create-dev-environment.ts`, `hosts.primaryApp` in `hosts/plan.ts`. The Open button would be a fourth consumer. | Users configure one thing; banner, bare hostname, Expo API URL and the menu bar agree. | Inside phase 1, since the registry needs the resolver anyway. |
| 5 | **Service identity from the preset, not the name**: `describeService(name, config, port)` returning `preset`, connection URL, `tablePlusUrl`, and whether it is HTTP, built on `inferDockerPreset` in `service-presets.ts`. | The banner decides a service is Postgres with `name.toLowerCase().includes("postgres")` while the compose side already knows the preset. A service keyed `db` gets no TablePlus link today. | Banner, registry and app share one answer; the `isHttpService` check in `hosts/plan.ts` moves into the same helper. | Inside phase 1. |
| 6 | **[changed, partly]** **A run is a first-class entity**: built as the registry below, but the watchdog heartbeat stays in `/tmp` and `ls` still reads containers — moving those is follow-up work, and `runs` covers the "what is running" question today.  the run registry (phase 1) becomes the record the other state hangs off. Routes and tunnel entries carry the run's `root` + `pid` as today but are pruned by consulting the run, the heartbeat moves from `/tmp/<hash>-heartbeat` to the run's own file under `~/.buncargo/runs/`, and `ls` reads runs first and only consults a container runtime for service state. | Four liveness signals with different semantics: heartbeat (pid + `released`), route pid, tunnel pid + 24 h TTL, container labels. `ls` needs Docker to answer "what is running". | One answer to "is this running" for the app, `ls`, `doctor` and takeover. Without it the registry is a fifth signal, not a replacement. | Is phase 1. The heartbeat move can trail in its own PR. |
| 7 | **[not done]** **Split `runDevFlow`**: the registry hooks went in without it and the flow stayed legible; splitting it for its own sake would have been a large diff over working code. Still worth doing.  into `runOneShot` (down / reset / migrate / seed / up-only) and `runServers` (classify → takeover → hosts → banner → watchdog → spawn), with phases named after the existing `timer.measure` labels. | ~250 lines interleaving one-shot exits, app classification, the takeover, a second `activateNamedHosts`, and four separate `env.logInfo()` call sites. | The registry's publish / patch / withdraw hooks attach to named phases instead of being sprinkled, and `buncargo stop --all` can reuse the teardown phase. The double activation after takeover is the kind of ordering bug this prevents. | While adding the registry hooks in phase 1, not as a separate pass. |
| 8 | **`--json` on `ls`, `status`, `doctor`**, serialised from the registry. | Only `env` emits JSON; the inspect commands are prose. | Scripts, agents and the app get the same view as the CLI without parsing text. | After phase 1; each is a formatter over existing data. |

What is deliberately **not** on this list: rewriting the hosts daemon (it is the most heavily reasoned-about code in the repo and works), changing the compose generation, or touching the config API beyond the `primaryApp` alias.

## Phase 1: run registry in the CLI (TypeScript, this repo)

### File

`~/.buncargo/runs.json`, next to `routes.json`, written through `defineListRegistry` in `src/core/registry-file.ts` (atomic temp-file rename, validator on read, file deleted when empty) and serialized with `withFileLock`. Path helper `getRunsPath()` beside `getRoutesPath()` in `src/core/hosts/paths.ts` (it is a machine-wide state file, not a hosts file, so consider moving the `~/.buncargo` helpers to `src/core/paths.ts` at the same time; not required).

```jsonc
{
  "version": 1,
  "runs": [
    {
      "projectPrefix": "lullu",
      "projectName": "lullu-t3code-f003056f-t3code-f003056f",
      "root": "/Users/…/.t3/worktrees/lullu/t3code-f003056f",
      "worktree": "t3code-f003056f",          // null for the main checkout
      "branch": "fix-login",                  // best effort, from git HEAD
      "pid": 86911,
      "startedAt": "2026-09-03T10:47:56.971Z",
      "updatedAt": "2026-09-03T10:48:12.101Z",
      "primaryApp": "platform",
      "hosts": { "active": true, "tld": "localhost" },
      "cli": {                                // how to invoke *this* buncargo again for this run
        "program": "/Users/…/.bun/bin/bun",   // process.execPath
        "script": "/Users/…/node_modules/buncargo/dist/cli/bin.js"  // process.argv[1]
      },
      "apps": [
        {
          "name": "platform",
          "port": 9273,
          "pid": 86920,                       // the spawned dev server; null when reused from another run
          "attached": false,                  // true for the app holding the TTY (Expo)
          "url": "https://t3code-f003056f.lullu.localhost",
          "loopbackUrl": "http://localhost:9273",
          "publicUrl": null,
          "hostname": "t3code-f003056f.lullu.localhost",
          "status": "ready"                   // "starting" | "ready" | "reused" | "failed" | "stopped"
        }
      ],
      "services": [
        {
          "name": "postgres",
          "preset": "postgres",               // from inferDockerPreset(); "custom" otherwise
          "port": 7432,
          "url": "postgresql://postgres:postgres@localhost:7432/lullu",
          "loopbackUrl": "http://localhost:7432",
          "hostname": null,
          "publicUrl": null,
          "tablePlusUrl": "postgresql://postgres:postgres@127.0.0.1:7432/lullu?env=development&name=…&tLSMode=0",
          "container": {                      // what `buncargo stop` needs without loading config
            "runtime": "docker",              // "docker" | "apple"
            "name": "lullu-t3code-f003056f-t3code-f003056f-postgres-1"
          },
          "status": "ready"                   // "starting" | "ready" | "stopped"
        }
      ]
    }
  ]
}
```

Notes on the shape:

- One entry per `root`. A second `buncargo dev` in the same checkout that reuses the first run's servers must not replace the entry (same rule as `classifyRouteClaim` returning `keep`); a takeover replaces it (different pid, same root). Encode this as `claimRun(existing, incoming)` with the same three outcomes so the two registries cannot drift.
- Liveness is `isRouteOwnerAlive(pid)` plus the heartbeat's `released` flag. A released run (Ctrl-C, containers left to the watchdog) is withdrawn, not shown as running.
- `tablePlusUrl` is computed by the existing `tablePlusUrl()` in `src/environment/tableplus.ts`. Move the "is this postgres" decision out of the banner in `src/environment/logging.ts` (currently `name.includes("postgres")`) into one helper on top of `inferDockerPreset()` in `src/core/service-presets.ts`, and use it from both the banner and the registry.
- `primaryApp` resolution, in one helper used by both the registry and the banner: `options.hosts.primaryApp` → `options.frontendApp` → the first selected app that no other selected app lists in `requiredApps` → the first selected app.
- The file contains the dev database password. It is the compose default (`postgres`) or whatever is already in `dev.config.ts` in the repo, and `~/.buncargo` is user-owned; still write it `0600`.

### Hook points in `src/cli/run-cli.ts`

| When | Call | Where today |
| --- | --- | --- |
| Named hosts activated and tunnels opened, before the banner | `publishRun(env, { pid, primaryApp, apps: "starting" })` | after the `activateNamedHosts` calls (lines ~249 and ~345), next to `startHeartbeat` (~380) |
| An app becomes ready / is reused / fails | `patchRun(root, { apps: [{ name, status }] })` | `src/environment/servers.ts` where readiness is decided |
| A dev server exits (killed from the menu bar or on its own) | `patchRun(root, { apps: [{ name, status: "stopped" }] })` | the `close` handler in `superviseChildren`, `src/core/process/dev-servers.ts` |
| Services come up | `patchRun(root, { services: [{ name, status: "ready", container }] })` | after the readiness poll in `src/environment/lifecycle.ts` |
| Public tunnel URLs change | `patchRun(root, { publicUrls })` | wherever `env.setPublicUrls` is called from `dev-tunnels.ts` |
| Teardown | `withdrawRun(root, pid)` | next to `releaseNamedHosts` (~180) and `stopHeartbeat` (~421/438), including the `CliError` path |

`publishRun` must never fail the dev run: log at `warn` and continue, like the hosts registry does.

### CLI surface

- `buncargo runs` prints the pruned registry as a table; `buncargo runs --json` prints the file after pruning. Add to `commands/registry.ts` so help and the `bin.ts` switch stay in step. This is also the debugging tool for "why does the menu bar not show my project".
- `buncargo doctor` gains a line: stale run entries pruned.
- `buncargo stop` is the kill surface the menu bar calls (below). It also works from a terminal: `buncargo stop api`, `buncargo stop postgres`, `buncargo stop --all`.

### Killing one app or service: `buncargo stop`

The menu bar never signals processes or talks to Docker itself. It runs `buncargo stop --root <root> <name>` using the `cli` block of the registry entry, so the exact interpreter and buncargo build that started the run is the one that stops it. The command reads only the registry entry, never `dev.config.ts`, so it is fast and cannot disagree with the running instance about names or ports.

| Target | What happens | Why it is safe for the rest of the run |
| --- | --- | --- |
| App with a `pid` | `SIGTERM` to the process tree via the existing `killChildTree` / `signalProcessTree` path, escalate to `SIGKILL` after 5 s. The supervisor's `close` handler marks it `stopped`. | A signal exit reaches `superviseChildren` with `code === null`, which is the one case it does **not** treat as failure. The other apps and the containers keep running; the run finishes only when every child has exited. |
| App with `attached: true` | Same signal, but `buncargo stop` refuses without `--force`, and the menu bar asks "This is the attached app; stopping it stops the whole run. Continue?" | Closing the attached app is by design what tears the rest down. |
| App with `pid: null` (reused from another run) | `killPortOwner(port)`, the same helper the takeover prompt uses. Confirm in the UI, since that server belongs to another terminal. | The run that reused it will report the app as gone on its next health check; it never owned the process. |
| Service | `stopBuncargoContainers([container])` through the runtime named in the entry (`docker stop` / `container stop`); mark `stopped`. Not `kill`: a `stop` is honoured by any `restart:` policy, a `kill` might be undone by it. | Nothing restarts a stopped container: the watchdog only tears down, it never brings up. Apps that need the service will start failing requests, which is the point of killing it. |
| `--all` | `SIGTERM` the run's own `buncargo dev` pid, which runs the normal teardown (release routes, stop heartbeat, kill children), then `dev --down` semantics for containers via `stopBuncargoContainers` on every container of the project. | This is the existing Ctrl-C path, invoked from outside. |

Exit codes: 0 stopped, 2 target not found in the registry, 3 refused (attached app without `--force`). The menu bar surfaces stderr in a toast.

Out of scope for the first cut: restarting a killed app from the menu bar. It is not hard, since `buncargo dev --apps=<name>` in the root already reuses healthy apps and spawns only the missing one, but that second run becomes the owner of the new process and the row would then belong to two pids. Listed under open questions.

### Tests

- `src/core/run-registry.test.ts`: read/write/prune/claim, mirrored from `src/core/hosts/registry.test.ts`.
- A fixture `docs/fixtures/runs.v1.json` (or under the Swift package) checked by both the TypeScript validator and the Swift decoder, so a schema change breaks a test on both sides.

## Phase 2: the menu bar app (Swift)

### Location and layout

In this repo under `menubar/`, so the registry schema and its only consumer change in one PR. Nothing in `package.json` `files` picks it up, so npm consumers are untouched.

```
menubar/
  Package.swift                 # swift-tools 6.0, macOS 14, one executableTarget
  Sources/BuncargoBar/
    App.swift                   # @main, MenuBarExtra(.window), AppDelegate → .accessory, --status CLI mode
    RunRegistry.swift           # Codable models for runs.json v1, version check, pid liveness (kill(pid, 0))
    RegistryWatcher.swift       # DispatchSource on the ~/.buncargo directory fd + 5 s timer fallback
    RunStore.swift              # ObservableObject: load → prune → group by projectPrefix → sort (Main first)
    DaemonHealth.swift          # GET https://127.0.0.1:<httpsPort>/health per hosts-daemon.json, self-signed OK
    MenuBarLabel.swift          # SF Symbol "shippingbox" + running count; dimmed at 0
    MenuContentView.swift       # headers + rows + footer
    RunRow.swift                # dot, name, branch, Open button, ▾ with hover popover
    RunDetailView.swift         # APPS / SERVICES lists with open / copy / TablePlus
    Actions.swift               # NSWorkspace.open, NSPasteboard, TablePlus detection, reveal root
    Preferences.swift           # launch at login (SMAppService), show ports, editor
  scripts/
    package.sh                  # swift build -c release → BuncargoBar.app (LSUIElement, ad-hoc codesign)
    install.sh                  # package + copy to /Applications + open
    launch.sh                   # clears quarantine flag, opens
```

### Behaviour

- **Data**: read `~/.buncargo/runs.json`, drop entries whose pid is dead, group by `projectPrefix`, order Main first then worktrees by `startedAt`. Watch the directory, not the file: buncargo writes through a temp file and a rename, so a file watch would hold a stale inode (same reasoning as `watchHostsState` in the daemon). Poll every 5 s as the backstop that notices a dead pid, which no filesystem event announces.
- **Open**: `NSWorkspace.shared.open(URL(primaryApp.url))`. Use `url` (named https host) when `hosts.active` is true and the daemon health body lists that hostname, otherwise `loopbackUrl`. This is the same guard `waitForDaemonRoutes` applies in the CLI: a route is a file until the daemon serves it.
- **▾ panel**: `.onHover` with a 150 ms delay opens an `NSPopover`-backed `.popover` anchored to the chevron; click toggles it for trackpads that do not hover well. Rows: app name, URL, open, copy; `publicUrl` as a second line when present. Services: connection URL, copy, and for `preset == "postgres"` a TablePlus button that calls `NSWorkspace.shared.open(tablePlusUrl)`. TablePlus registers the `postgresql://` scheme, so no CLI is needed; show the button only when `NSWorkspace.urlForApplication(withBundleIdentifier: "com.tinyapp.TablePlus")` resolves. HTTP services (mailpit, typesense) get open + copy like apps.
- **Kill (`✕`)**: on every app and service row in the panel. Runs `buncargo stop --root <root> <name>` through `Process` with the entry's `cli.program` and `cli.script`, shows a spinner on the row until the registry patch lands (the CLI marks the entry `stopped`, which the directory watcher picks up). Confirmation only in the two cases the CLI flags as risky: the attached app, and an app this run reused from another terminal. A plain `SIGTERM` of a dev server needs no dialog; that is what Ctrl-C does all day.
- **Stop run**: footer button, runs `buncargo stop --root <root> --all`, always confirms, since it kills servers in a terminal the developer may be looking at, the same reason the takeover prompt exists.
- **Status dot**: green if all `apps[].status` are `ready`/`reused`; half if any `starting`; red if `hosts.active` and any hostname is missing from the daemon's `hostnames`; grey if the daemon does not answer at all and hosts are active.
- **Footer**: daemon health line (from `hosts-daemon.json` port and `readProxyHealth` semantics: status, `lastReloadAt` age), Refresh, gear (preferences), Quit.
- **`--status`**: like cursorbar, `BuncargoBar --status` prints one line per run and exits, for troubleshooting without the UI.

### Build and install

`bash menubar/scripts/install.sh` builds with the system Swift toolchain (Xcode Command Line Tools are enough), bundles into `BuncargoBar.app` with `LSUIElement` so it has no Dock icon, ad-hoc signs, copies to `/Applications`, opens. First launch from Finder may need right-click → Open; `launch.sh` clears the quarantine flag.

### Offering the app from `buncargo dev`

The first `buncargo dev` on a Mac that does not have BuncargoBar installed asks once, in the same shape as the named-hosts first-run prompt in `src/core/hosts/onboarding.ts`:

```
  buncargo has a menu bar app that lists your running projects and services
  (open URLs, copy connection strings, TablePlus, stop apps). Install it?

  Enter to install  ·  s to skip this once  ·  n to never ask again
  >
```

| Answer | Effect |
| --- | --- |
| Enter | `runBarInstall()` (below), then `open -a BuncargoBar`. The run continues either way; a failed install prints one `warn` line with the manual command and never blocks startup. |
| `s` | Nothing persisted. Asks again on the next run. |
| `n` | Writes `~/.buncargo/bar-declined` (timestamp, like `hosts-declined`). Never asks again until `buncargo bar install` or `buncargo bar reset` removes it. |

**When it asks.** All of these must hold, checked in this order so the cheap file checks come first:

1. Platform is macOS. Linux and Windows have no app; nothing is printed.
2. Not `BUNCARGO_BAR=0` and not CI (`isCI()` in `src/core/runtime-flags.ts`, the same detector `isHostsForcedOff` uses).
3. `~/.buncargo/bar-declined` does not exist.
4. The app is not installed: neither `/Applications/BuncargoBar.app` nor `~/Applications/BuncargoBar.app` exists, and `~/.buncargo/bar.json` (written by the installer, records path and version) does not point at an existing bundle. No Spotlight query; two `existsSync` calls are the whole cost, which matters because `dev` runs constantly.
5. stdin and stdout are TTYs (`isInteractive()`). Non-interactive runs print nothing at all; unlike hosts, the app changes no URL, so there is nothing a script needs to know.
6. The hosts first-run prompt did **not** fire in this run. Two setup questions back to back on a fresh machine is exactly the onboarding buncargo avoids elsewhere; the hosts one wins, and the app question waits for the next run.

**Where it asks.** In `run-cli.ts`, immediately after the `activateNamedHosts` step and before containers start, so it lands before any log output and never interleaves with dev-server logs. It is a single readline question with no timeout, the same as the hosts prompt; the user is at the terminal by construction of rule 5.

**Not asked, ever**, from `env`, `ls`, `status`, `doctor`, `prisma` or `typecheck`. Only `dev` onboards.

**[changed]** Rule 6 is enforced by `claimFirstRunPrompt()` in `core/prompt.ts` rather than by the offer checking what the hosts prompt did: whichever prompt asks first in a run consumes the single slot, so the ordering in `run-cli.ts` decides the winner and neither prompt has to know about the other.

### `buncargo bar` command group

Mirrors `HOSTS_SUBCOMMANDS` in `src/cli/commands/registry.ts` so `bin.ts` and help cannot drift:

| Subcommand | Does |
| --- | --- |
| `install` | Downloads the latest `bar-v*` GitHub release asset (`BuncargoBar.app.zip`), verifies the sha256 published beside it, unzips into `/Applications` (falls back to `~/Applications` when not writable), clears the quarantine attribute because the bundle is ad-hoc signed, writes `~/.buncargo/bar.json`, removes `bar-declined`, opens the app. Non-interactive by design so the prompt and a script share one path. `--source` builds from `menubar/` with `swift build` for people who want that. |
| `status` | Installed path and version, latest release, whether the app is running (`pgrep -x BuncargoBar`), whether it was declined. |
| `open` | `open -a BuncargoBar`; installs first when missing. |
| `uninstall` | Quits the app, removes the bundle and `bar.json`. Does not write `bar-declined`; the next `dev` asks again, which is the honest reading of "I removed it". |
| `reset` | Removes `bar-declined` so the next `dev` asks again. |

`doctor` reports the app the way it reports hosts: installed / declined / not installed, with the command to change that. `doctor --fix` does not install it; the app is optional and a fix pass must not trigger a download.

The app and the CLI version independently. `bar-v*` tags are cut by the release workflow below; a CLI publish does not build the app. The app's own update checker (phase 3) takes over after the first install, so the CLI only ever installs, never upgrades.

### Release workflow: `.github/workflows/release-menubar.yml`

Part of phase 2b, and a prerequisite for `buncargo bar install` having anything to download. It follows the conventions of the two existing workflows (`actions/checkout@v4`, `workflow_dispatch` as the manual entry point, one job, explicit `permissions`), but runs on macOS because SwiftPM needs the macOS SDK.

**Triggers.**

- `push` on tags matching `bar-v*`. The tag is the source of truth for the version: `bar-v1.2.0` → `CFBundleShortVersionString=1.2.0`, `CFBundleVersion` = the run number. `menubar/scripts/package.sh` already takes `VERSION` and `BUILD_NUMBER` from the environment, so the workflow only exports them.
- `workflow_dispatch` with a `version` input, which creates the tag and then runs the same job, for cutting a release from the Actions tab without a local `git tag`.

**Job `build` on `macos-15`** (Apple silicon runner, Xcode 16 preinstalled, Swift 6):

1. Checkout.
2. A "Show toolchain" step that prints `xcode-select --print-path`, `swift --version` and `xcodebuild -version`. Taken from cursorbar's workflow: it does not pin an Xcode path, and neither should we. A hard `xcode-select -s /Applications/Xcode_16.app` breaks the moment the runner image renames or drops that bundle, while the printed versions are what you need when a build starts failing after an image rotation. `macos-15` is the pin that matters: it ships Xcode 16 with Swift 6, and `macos-14` only has Swift 5.10.
3. No build cache. The target has no dependencies and builds in about a minute; caching `.build` on macOS runners is large, ABI-sensitive and a source of confusing failures. cursorbar does not cache either.
4. `swift build -c release --arch arm64 --arch x86_64` from `menubar/`, producing one universal binary. cursorbar builds arm64 only; we pay the second compile because Intel Macs still exist and the target is small. Drop `--arch x86_64` if it ever becomes a problem.
5. `bash menubar/scripts/package.sh` → `BuncargoBar.app`. The script does the ad-hoc `codesign --force --deep --sign -`, same as cursorbar.
6. **Optional Developer ID signing and notarization**, entered only when the `APPLE_CERTIFICATE_P12`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID` and `APPLE_APP_PASSWORD` secrets are all present: import the certificate into a temporary keychain, `codesign --options runtime --timestamp` with the Developer ID identity, `xcrun notarytool submit --wait`, `xcrun stapler staple`. Without the secrets the step is skipped and the ad-hoc bundle ships, which is why `buncargo bar install` clears the quarantine attribute. Adding the secrets later changes nothing else.
7. Smoke test the bundle: `BuncargoBar.app/Contents/MacOS/BuncargoBar --status` against a fixture `runs.json` copied into a temporary `HOME`, asserting it lists the fixture's runs. This is the same `--status` mode cursorbar uses for troubleshooting, and it means a release that cannot decode the current schema fails here rather than on someone's Mac.
8. `ditto -c -k --sequesterRsrc --keepParent BuncargoBar.app BuncargoBar-<version>.zip`. `ditto`, not `zip`, so the code signature survives, and `--sequesterRsrc` (from cursorbar) so resource forks and extended attributes go into a `__MACOSX` side folder instead of being lost or interleaved, which is what keeps the signature valid after the archive is expanded by tools other than Finder.
9. `shasum -a 256 BuncargoBar-<version>.zip > BuncargoBar-<version>.zip.sha256`. cursorbar only prints the checksum into the log; we upload it because `buncargo bar install` verifies against it.
10. Create the release. cursorbar uses `softprops/action-gh-release@v2` with `generate_release_notes: true`, which is idempotent (re-running a tag uploads into the existing release) and needs no scripting. We cannot use it as-is: auto-generated notes run from the previous tag of any kind, and in this repo the previous tag is usually a CLI `v7.x` tag, so app release notes would list CLI commits. Use `gh release create bar-v<version> --title "BuncargoBar <version>" --generate-notes --notes-start-tag <previous bar-v tag> <zip> <sha256>` (the `gh` CLI is preinstalled on the runner), with `permissions: contents: write` at the workflow level as cursorbar does. Guard with `gh release view` first so a re-run of an existing tag uploads assets with `gh release upload --clobber` instead of failing.

The version comes from the tag exactly as in cursorbar, `VERSION="${GITHUB_REF_NAME#bar-v}"`, exported into `package.sh`.

**Asset contract** consumed by `buncargo bar install` and by the app's update checker, so it is fixed here rather than in either consumer:

| Item | Value |
| --- | --- |
| Tag | `bar-v<semver>` |
| Zip | `BuncargoBar-<semver>.zip`, containing `BuncargoBar.app` at the top level |
| Checksum | `BuncargoBar-<semver>.zip.sha256`, `shasum` format |
| Latest | `GET /repos/HansKristoffer/buncargo/releases?per_page=20`, first non-draft, non-prerelease entry whose tag starts with `bar-v`. Not `releases/latest`, which would return whichever tag was created most recently, including a CLI tag. |

**Job `verify` on pull requests** touching `menubar/**` or the fixture: `swift build` and `swift test` on `macos-15`, plus the same `--status` smoke test. Lives in the same file under a `pull_request` trigger with `paths:` filtering, so a schema change to `runs.json` that breaks the Swift decoder fails the PR that makes it. The TypeScript side of that contract runs under the existing `bun test`.

**Not in the workflow.** No Homebrew cask bump; if the tap happens in phase 4, a separate job runs `brew bump-cask-pr` and needs a personal token for the tap repository. No auto-tagging on merge: cutting an app release is a deliberate act, like the npm publish workflow, which is also manual.

## Phase 3: liveness and polish

- App readiness pushed by the CLI (`patchRun` on each transition) so dots go green as servers come up, not on a poll.
- Branch subtitle: read `<root>/.git` (a file for worktrees) → `gitdir` → `HEAD` → `ref: refs/heads/<branch>`; fall back to the worktree name. Do this in the CLI at publish time so the app never touches git.
- Menu bar label shows the count of running runs; a red `!` when any run's hosts are red, mirroring cursorbar's error badge.
- Preferences: launch at login (`SMAppService.mainApp`), show ports next to URLs, prefer loopback URLs, editor for "Open in editor" (`cursor` / `code` / `zed` / custom).
- Update checker against GitHub releases, one-click download (cursorbar's `UpdateChecker.swift` is a direct template).

## Phase 4: actions and distribution

- **Restart** a killed app: `buncargo stop` learns `--restart`, or a sibling `buncargo start <app>` that asks the *running* `buncargo dev` to respawn (a control file next to the heartbeat that the supervisor polls, keeping the process under the original owner). Decide after phase 2 has shown how often a kill is followed by a start.
- **Reveal in Finder** / **Open in editor** / **Open terminal here** on the run row.
- Homebrew cask in a tap (`brew install --cask hanskristoffer/buncargo/buncargobar`) pointing at the same release zip `buncargo bar install` downloads, for people who manage everything through brew. When brew already manages the app, `bar install` and `bar uninstall` defer to it.

## Sequencing and effort

| Phase | Ships | Rough size |
| --- | --- | --- |
| 0 | CI workflow, state-paths module, prompt primitive (refactors 1–3) | 1 day, no release needed |
| 1 | `runs.json` + `buncargo runs --json` + `buncargo stop`, primary-app and service-identity resolvers, dev-flow split (refactors 4–7) | 3–4 days, one buncargo minor release (7.5.0) |
| 2 | BuncargoBar MVP: list, Open, hover panel, copy, TablePlus, kill per app/service, Stop run | 2–3 days |
| 2b | `release-menubar.yml` (tag-triggered macOS build, universal binary, optional notarization, zip + sha256, GitHub release, PR verify job), `buncargo bar` command group, install prompt in `dev` with skip / never-again | 1–2 days; the workflow and first `bar-v0.1.0` release land before the CLI release that adds the prompt |
| 3 | readiness dots, daemon line, branch, preferences, updates | 1–2 days |
| 4 | Restart, editor/terminal, brew tap, `--json` on the inspect commands (refactor 8) | 1–2 days |

Phase 0 is the cheapest stability gain in the whole plan and should go in first regardless of whether the app is built. Phase 1 is a prerequisite and stands on its own (the `--json` output is useful for scripts and agents regardless of the app). Phase 2 needs a published or `bun link`ed buncargo that writes the registry.

## Decisions taken in this plan

- **Swift, not Electron/Tauri**: the reference app is Swift, the UI is a menu bar popover, and a Bun-based option would need a bundled runtime for a 200-line UI.
- **Registry file, not `buncargo ls --json` from the app**: `ls` needs a container runtime and one process spawn per refresh; the file is instant, works with `--no-docker-autostart` and Apple `container`, and reuses the registry pattern the hosts code already trusts.
- **Same repo**: the app is a client of an internal file format. A separate repo would mean coordinating two releases for every schema change.
- **Prompt from `dev`, never from other commands, never twice in one run, never without a TTY**: the same rules the hosts prompt already follows, so the two onboarding steps feel like one system. "Skip" is not persisted and "never" is a marker file, again matching hosts.
- **Download, not build**: the prompt's install path pulls a prebuilt zip rather than compiling from source, because a Swift toolchain is not a reasonable requirement for someone who just typed `bun dev`.
- **"Main" label**: the non-worktree checkout is labelled `Main` regardless of its branch name; worktrees show their directory name with the branch beneath, because AI worktrees (`t3code-<hash>`) are only recognisable by branch.

## Open questions

1. Should the primary app be configurable per project outside `options.hosts.primaryApp`, for projects without named hosts? The plan falls back to `frontendApp` and then to the dependency root, which covers Lullu and Geysier today.
2. Should the panel also show apps that are configured but not started in this run (greyed), so `--apps=api` runs are visible as partial? Default here: show only started apps.
3. Windows/Linux are out of scope; the registry file is cross-platform so a future tray app could read it.
4. After killing an app, should the row offer Restart right away (phase 4 sketch above), or is kill mostly used to free a port or stop a runaway process? This decides whether the control-file channel into the running `buncargo dev` is worth building.
