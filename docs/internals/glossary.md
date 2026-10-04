# Glossary

Terms whose meaning matters across buncargo. Use them this way in code, comments, docs and PRs.

## Checkouts and runs

| Term              | Meaning                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout / root   | One directory holding a `dev.config.ts`: the main clone or a worktree. Everything buncargo isolates is isolated per checkout.            |
| Worktree          | A Git worktree checkout. Its directory name joins the project identity unless the directory already carries it.                         |
| Run               | One `buncargo dev` (or library `start()`) for a checkout: its services, apps, hosts and tunnels.                                        |
| Session           | A run's entry in `~/.buncargo/runs.json`, addressed by `sessionId`. Several sessions can coexist for one root.                           |
| Claim             | Writing a run's entry before its first container exists, so the sweep never sees a fresh stack as unowned.                             |
| Release           | The run ended on purpose; `releasedAt` is set and its containers wait out the idle hold for the next run to reuse.                       |
| Retire            | Remove an entry because nothing is left to hold: an explicit `stop()` tore the containers down, or the sweep did.                       |
| Stop              | Tear down now. `stop()` and `buncargo stop` stop or `down` containers instead of releasing them.                                        |
| Idle hold         | How long a released run's containers are kept (`idleTimeoutMs`). The CLI passes three minutes; absent means "as long as the checkout". |
| Owner lost        | The sweep found an unreleased owner dead (`ownerLostAt`). The short crash grace counts from here.                                       |
| Takeover          | Stopping another run's servers for the selected apps and spawning them here instead of reusing them.                                   |
| Reuse             | An app or service already up for this checkout is used as-is instead of started twice.                                                |

## What a run starts

| Term              | Meaning                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| Service           | A container from `services` (Postgres, Redis, a custom image), generated into the Compose model.                     |
| Preset            | A built-in service builder (`service.postgres()` …). What a service *is* comes from its preset, not its name.        |
| Stack             | Containers another CLI runs (Supabase), declared by an integration. Allocated like services, never in Compose.       |
| Job               | A service with `kind: "job"` that runs to completion during preparation.                                             |
| App               | A dev server or other process from `apps`, spawned and supervised by buncargo.                                       |
| Worker            | An app with no endpoint. Ownership is claimed per checkout so two consumers never run at once.                       |
| Essential         | The default. An app with `essential: false` is parked when it exits instead of ending the run.                        |
| Wave / layer      | Apps start in two tunnel phases; `startAfter` splits a phase into layers. Without it a phase is one layer.            |
| Attached app      | The app holding the terminal in stream mode (`interactive`). In the TUI every app has its own pseudo-terminal.       |
| Capture           | A value read from an app's output (a URL, a token), with optional `label` and `env` names.                            |
| Integration       | A plain `BuncargoIntegration` object (`expo()`, `shopify()`, `supabase()`) applied to the config before validation.  |
| Lease             | An exclusive claim on a resource held by one `dev` process machine-wide (`AppConfig.exclusive`).                      |

## Machine-wide state

| Term              | Meaning                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | The container backend a run uses: Docker or Apple `container`. `auto` probes; an explicit choice never falls back.            |
| Sweep             | The one cleanup policy (`container-runtime/sweep.ts`): decides which unowned stacks come down. Never removes volumes.          |
| Watchdog          | One background process per machine that runs the sweep on a loop.                                                             |
| Offset / port block | A checkout's ports are the config's base ports plus its offset. Offsets are claimed per checkout in `~/.buncargo/offsets.json`. |
| Named host        | An `https://<name>.localhost` URL served by the root hosts daemon's proxy, backed by a route in `~/.buncargo/routes.json`.     |
| Process identity  | A pid plus its birth time (`v2:` prefixed). Liveness reads an unreadable identity as alive; signalling requires a strict match. |
| BuncargoBar       | The macOS menu bar app. It only reads the run registry and calls `buncargo stop`.                                             |
