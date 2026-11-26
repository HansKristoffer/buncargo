# Integrations and stacks

User-facing guide: [integrations](../integrations.md).

`src/expo/`, `src/shopify/`, `src/supabase/` and `src/firebase/` (published as `buncargo/expo`,
`buncargo/shopify`, `buncargo/supabase`, `buncargo/firebase`) are integrations: plain
`BuncargoIntegration` objects applied by `config/integrations.ts` (`applyIntegrations`) in order before validation. It composes hooks (the
config's first), appends checks, and is idempotent (a symbol marks an applied config).

Core reaches integrations only through `appEnv`, `onAppReady`, `secretScopes`, `describeApp`,
`bannerHint`, `describe`, `exportEnv`, `setupChecks` and `commands`. Expo lives entirely there:
without `expo()` no app is Expo. Profiles may override integrations via
`profiles.<name>.integrations` (`false` to drop all integrations, or an array overriding matching
integrations by `name` via `mergeProfileIntegrations`). When a profile restricts `apps`,
`resolved.activeApps` (expanded transitively across `requiredApps` / `startAfter`) lets
integrations gate env vars, credential isolation and setup checks automatically.
`cli/integration-commands.ts` dispatches `buncargo <name> <cmd>`, preferring the configured
instance (its options) and falling back to the built-ins, so `expo sim` works without a config.

The names an integration adds reach a config's types through `BuncargoIntegration<TAdds>` and the
`integrations` tuple `defineDevConfig` infers. Before 16.0 they came from a global interface
augmentation, so importing `buncargo/firebase` anywhere made `"firebase"` legal in every config.
`TAdds` lives in a type-only `"~adds"` property; an integration typed plain `BuncargoIntegration`
adds no names.

The config's own values win over an integration's: its `env` over the integration's `env` keys, an
app it defines over one the integration adds, and an app's `staticEnv` and `envVars` over `appEnv`.
Shopify's `env` and every `appEnv` over `staticEnv` were on top until 16.0.

## Shopify

- The CLI app is `essential: false` with `p`/`g` actions and no `interactive`. A `preflight`
  (`login.ts`) trusts an unexpired stored session and otherwise runs `shopify app info --json` with
  the terminal, falling back to `auth login`; never `CI=1`, which also disables the device-code
  login.
- `link.ts` links into a scratch toml and takes only `client_id` and `name`, the rest from
  `shopify.app.toml` and the target's `dev_store_url`, because `app config link` rewrites the whole
  file from the app's bare remote config. The link fix is only offered without a valid
  `client_id`; a `CheckOutcome` may set its own `severity`, which is how an expired session warns
  while a missing one fails.
- One owner per process. The app toml's `web_directories` points at the generated
  `.buncargo/shopify/web`, whose web has the frontend's fixed `port` and runs only
  `buncargo wait --hold`. An empty `web_directories` makes Shopify CLI start every
  `shopify.web.toml`: a second API and Vite.
- `config()` is lenient without the toml, so CI and fresh clones load; the checks report it.
- `cli-contract.test.ts` (opt-in) pins the bundle strings buncargo depends on in 3.x and 4.x;
  `example/shopify-plugin` boots end to end with a fake `shopify` binary.

## Stacks

`BuncargoIntegration.stacks` is containers another CLI runs, and `ServiceConfig.external: { stack }`
the services one provides.

- They are allocated ports, URLs, env, hosts and registry rows like any service, and never reach
  the Compose model (`buildComposeModel` skips them; `environment/stacks.ts` splits them out).
- Selecting one of a stack's services selects all of them (`resolveServiceDependencies`), because
  one CLI starts them together.
- `lifecycle.ts` runs `stack.up` beside `compose up`, and `stop()` runs every stack's `down` argv,
  both under the project lifecycle lock like Compose: otherwise a sweep's `supabase stop` could
  finish just after a new run's `supabase start` returned against the still-running stack. A first
  `supabase start` can hold that lock for minutes; `stop` and a second run in the checkout wait up
  to 120s for it, and the sweep skips the project that pass.
- The claim records that argv in the run entry's `stacks` (and gives external services `stack`
  instead of `container`), so the sweep can stop a released stack after its hold with no config:
  `sweepStacks` decides with the same `decideSweep`, counting the stack as running (its containers
  carry none of our labels, so nothing lists them), clears `stacks` once stopped, and
  `finishedRuns` never retires an entry that still has some. `pendingStacks` keeps the
  watchdog alive meanwhile.
- The recorded argv starts with the checkout's own `node_modules/.bin/supabase`, which a deleted
  worktree takes with it; the spawn failed every pass and the stack stayed up for good. So
  `runStackDowns` retries the basename on `PATH`, and failing that stops the containers by the
  `composeProject` the entry records, through the Docker adapter (stopped, never removed: volumes
  stay). Docker only: no integration CLI runs on Apple's runtime.
- `stop` refuses one external service (exit 3) and runs the stacks when stopping the whole run.
- A buncargo older than this retires a stack-only entry at once, leaving that stack running as it
  would without the integration.

A stack's containers must carry `com.docker.compose.project` = `externalStackProjectName(projectName)`
(`core/ports.ts`: the name itself up to 40 characters, else a prefix plus a hash).
`classifyPortOccupant` reads that label as this run's, which is the whole ownership seam: without it
the allocator sees the stack's ports as foreign and shifts the block on every warm start. The
Supabase CLI sets the label from its project id, and cuts ids at 40 characters, which is where the
limit comes from. Compose ignores those containers on `down`: they have no
`com.docker.compose.service` label.

## Supabase

- The Supabase CLI reads every `config.toml` key from a `SUPABASE_<SECTION>_<KEY>` env var, so
  `config()` never rewrites the toml. The env builder sets the project id, the ports (unpublished
  ones as base + `portOffset`) and auth's site and redirect URLs, plus
  `SUPABASE_URL`/keys/`SUPABASE_DB_URL` for apps, and `buncargo exec -- supabase …` targets the
  checkout for free.
- The anon/service-role keys are HS256 over the CLI's fixed demo claims, signed with
  `auth.jwt_secret`, and match `supabase status` byte for byte; the publishable/secret keys are the
  CLI's local constants.
- `supabase start` on a running stack takes under a second and `migration up` with nothing to
  apply 0.3s, so neither is skipped by a check of ours.
- `stop` removes containers and keeps the volume (24s to start again), which is why the idle hold
  matters.
- An excluded container's service is not added. A stack keeps the settings it started with until it
  is stopped.

## Firebase

The Emulator Suite is a process, not containers, so it is an app rather than a stack, and it is not
held between runs. What it depends on in `firebase-tools` (checked against 15.34):

- Ports live only in the Firebase config (`configFile`, default `firebase.json`); there is no env
  override. `--config <file>` makes the file's directory the project directory, and
  `functions.source` is joined onto that directory, so an absolute path breaks it. The per-checkout
  copy therefore sits beside `configFile` (`firebase.buncargo.json`), not under `.buncargo/`, and
  `.firebaserc` is checked beside `configFile` before falling back to `workdir`. An unset hub, UI,
  logging, Eventarc or Tasks port makes the CLI pick a free one, so every port is written out.
- When `projectId` starts with `"demo-"` and `storage` is a multi-target array
  (`[{ target, rules }, ...]`), `generatedFirebaseConfig` collapses it to a single `{ rules }`
  object (preferring `target: "default"`, else the first entry with `rules`) so `firebase
  emulators:start --project demo-*` does not fail on missing `.firebaserc` targets.
- Adding `emulators.<name>` to the copy would make that emulator a target. Only the selected
  emulators get one, and `--only` always names them. Eventarc and Tasks are skipped by the CLI's
  target loop and only listen beside Functions, so they are safe to write whenever Functions runs.
- A web app's own code decides whether to call `connect*Emulator`, and with no variable it falls
  back to the SDK's default port, which another checkout's suite may hold. So for an emulator the
  web SDK dials that the run does not select, `unselectedEmulatorEnv` (pure) sets its variable to
  `127.0.0.1:9`, the discard port, where nothing answers. It is the default only for `demo-*`
  projects (`unselectedEmulators`), since any other id reaches the real product for what is not
  emulated, and a project may mean that.
- The hub writes `hub-<project id>.json` in `os.tmpdir()`, and a second suite on the same id reads
  the first one's (the CLI only warns). Each checkout's suite gets its own `TMPDIR` rather than its
  own project id, so the id the apps' SDK config uses stays the project's. It is a short directory
  under the system's (`bcfb-<checkout hash>`), not under the checkout: the Functions emulator puts
  its Unix socket there, and a worktree's path pushes it past the 103-byte limit on macOS.
- When `javaHeap` is set (`"auto"` = `clamp(floor(totalmem / 2 GiB), 1, 8)` or an explicit size
  such as `"6g"`), `appEnv` injects `-Xmx<size>` into `JAVA_TOOL_OPTIONS` while preserving existing
  flags and skipping if `-Xmx` is already set. When `process.env.JAVA_HOME` points to a missing
  `bin/java` executable, `appEnv` clears `JAVA_HOME=""` for the `firebase` app so a stale shell
  path never breaks emulator startup. A built-in `firebaseOom` capture detects JVM
  `OutOfMemoryError` output and logs an actionable warning pointing at `javaHeap`.
- When `isolateCredentials` is on (default `true` for `demo-*` projects), `appEnv` sets
  `GOOGLE_APPLICATION_CREDENTIALS=""` and points `CLOUDSDK_CONFIG` at an empty `gcloud` directory
  under the checkout's emulator temp dir (created in `hooks.beforeServers`) across the `firebase`
  app, sibling apps, and `exportEnv` so developer `gcloud`/ADC sessions cannot leak into local
  demo emulators. All emulator env vars, credential isolation and setup checks are automatically
  skipped when the active profile omits `"firebase"` from `activeApps`.
- `pubsubTopics`: created idempotently against the Pub/Sub emulator (`src/firebase/pubsub.ts`) in
  `onAppReady` as soon as `firebase` reports ready, before downstream `startAfter` apps or
  `seed.afterApps` run.
- `functionsEnv`: rendered atomically with `0o600` permissions beside `functions.source` before
  servers start (`src/firebase/functions-env.ts`), combining optional Infisical scopes (declared
  via `secretScopes` so `secrets check` / `prefetch-secrets` include them) and explicit `values`,
  stripping Firebase reserved keys and credentials, and backing up/restoring any pre-existing
  `.env` on `hooks.afterServersStop`.
- `checks.ts` parses `java -version` (handling legacy `1.8.x` -> `8` and modern `17.x`/`21.x`) and
  validates against the installed `firebase-tools` major version for all JVM emulators
  (`firestore`, `database`, `storage`, `pubsub`): Java `< 11` always fails; Java `11..20` warns
  on `firebase-tools` 13.x (or unknown) and fails on 14+; Java `>= 21` passes. CLI install hints
  use the checkout's detected package manager (`detectPackageManager`).
- Emulator ports are the app's `extraPorts`. They are spaced like the offset step (9099, 9199,
  9299…), so moving them by the offset alone put one checkout's Auth on the next one's Storage;
  claimed and probed with the block, a block that lands on another's emulators moves on.
- `--export-on-exit` runs on the first SIGINT/SIGTERM/SIGHUP/SIGQUIT; a second signal more than
  100 ms later skips the export. The CLI is run directly, not through `npx`/`bunx`, which forward
  the signal again, and the app has a long `stopGraceMs` for the single SIGTERM.
- The JVM emulators are spawned `detached`, in their own process groups. A clean stop ends them; a
  SIGKILL after the grace runs out leaves them holding their ports, and leaves the hub's locator in
  the checkout's `TMPDIR`. The next start removes a locator whose pid no longer runs; the JVMs'
  pids are the CLI's own and recorded nowhere, so nothing here can end them.
- The data directory defaults to `.firebase-emulator-data` beside `firebase.json`, not under the
  per-checkout `.buncargo/`, which is disposable state; nothing in buncargo removes it.
- `exportEnv(ctx)` publishes the active emulator host vars, project IDs, and `publicEnvPrefix`
  copies to `runs.json` `exports` for cross-repo links, and only when `firebase` is in
  `ctx.selectedApps`, so a run that did not start the emulators leaves no dead emulator endpoints
  in the registry.
