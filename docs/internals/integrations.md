# Integrations and stacks

User-facing guide: [integrations](../integrations.md).

`src/expo/`, `src/shopify/` and `src/supabase/` (published as `buncargo/expo`, `buncargo/shopify`,
`buncargo/supabase`) are integrations: plain `BuncargoIntegration` objects applied by
`config/integrations.ts` (`applyIntegrations`) in order before validation. It composes hooks (the
config's first), appends checks, and is idempotent (a symbol marks an applied config).

Core reaches integrations only through `appEnv`, `describeApp`, `bannerHint`, `describe`, `checks`
and `commands`. Expo lives entirely there: without `expo()` no app is Expo.
`cli/integration-commands.ts` dispatches `buncargo <name> <cmd>`, preferring the configured
instance (its options) and falling back to the built-ins, so `expo sim` works without a config.

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
- `lifecycle.ts` runs `stack.up` beside `compose up`, and `stop()` runs every stack's `down` argv.
- The claim records that argv in the run entry's `stacks` (and gives external services `stack`
  instead of `container`), so the sweep can stop a released stack after its hold with no config:
  `sweepStacks` decides with the same `decideSweep`, counting the stack as running (its containers
  carry none of our labels, so nothing lists them), clears `stacks` once stopped, and
  `finishedSessions` never retires an entry that still has some. `pendingStacks` keeps the
  watchdog alive meanwhile.
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
