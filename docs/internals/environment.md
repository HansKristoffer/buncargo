# Environment and preparation

`createDevEnvironment()` lives in `src/environment/`. It applies integrations, validates and
resolves the config (`resolveConfig`); `context.ts` then resolves identity, ports and URLs once
into a `DevEnvContext`, which holds only the resolved services and apps. `env-vars.ts`,
`lifecycle.ts`, `servers.ts` and `run-claim.ts` are built on it, and `create-dev-environment.ts`
only composes them. Extract a complex concern into a
focused module (logging, seeding) rather than growing the composition.

`context.ts` starts from `resolveCheckoutView` and builds every environment with `sharedEnv`
(`core/checkout-view.ts`), the same two `getEnvVar` answers from. `getEnvVar` was a second copy
that drifted: no captures, no `BUNCARGO_WORKSPACE_ID`, no CA path. It memoises the view per config
object, keyed by root and `process.env`; live state (named URLs, captures) is read on every call.
The context never shares the memo: an environment built after an allocation must read the new
block, not the view from before it. What `start()` leaves to the
CLI, and why, is in [what only `buncargo dev` does](./overview.md#what-only-buncargo-dev-does).

## Seeding

`seeding.ts` owns the only seed path: `runSeedIfNeeded` backs both `start()` and `env.runSeed()`
(which `buncargo dev --seed` calls with `force: true`). A failed seed fails `start()`; it does not
log and continue. `seed-startup.ts` shares selection for `seed.beforeApps: false`; any selected
`afterPreparation` service forces the serial path. `server-session.ts` owns the concurrent seed
task, cancellation and draining across CLI and library, including production builds and empty
sessions kept open for tunnels. The CLI defers the automatic seed through
`skipSeed`/`prefetchSeed`, and `server-session.ts` joins the seed before `afterServers` and
readiness. Concurrent output is prefixed by `exec`'s `outputPrefix` in the library; the CLI passes
`onOutputLine` and feeds it to the run's output as `seed`, so stream mode and the TUI both show it
and log it to `seed.log`.

## Secrets prefetch

`prefetch-secrets.ts` starts the distinct selected scopes immediately after startup preparation,
except in containers-only mode, and the start then awaits only their CLI session before the
claim, so an expired session stops it before any container (see [secrets](./secrets.md)).
Consumers await the shared cache and own their warn-once messages. Prefetch cancellation releases the CLI lock; failed startup drains fetches. The
`secrets` timing measures consumer waits, which can overlap other phases. See
[secrets](./secrets.md).

## Logging selection

`logInfo` accepts an optional `EnvironmentLogSelection`; CLI classification and the library
lifecycle pass the current run selection, including for tunnel banners. Integration hints run only
for displayed apps. Omit the selection for full configuration listings.

## Captures and generated files

`environment/captures.ts` is the one place a capture changes state (public URLs, `captured`,
hooks, generated files); `setPublicUrls` replaces the map, so captures merge into it. A capture's
`label` and `env` are what make a value generic: `env.details()` (labelled captures, then
integrations' `describe`) feeds `buncargo env`, the registry's `details` and BuncargoBar, and `env`
names go into the shared env beneath `config.env`. `cli/commands/open.ts` (`url`, `open`) resolves
app names, capture names, then those labels, so no integration needs its own URL commands.
`environment/generated-files.ts` writes atomically and skips unchanged content.

## Prisma

`src/prisma/migrations-applied.ts` uses a bounded, cancellable Bun SQL query against the loopback
Postgres URL to skip the automatic deploy only when every local migration is applied and no
failed or rolled-back attempt exists. Uncertainty runs deploy. `prisma.migrations` is relative to
`prisma.cwd` and also defaults `migrateCheck`; an overridden database URL never skips based on the
local service.

`PrismaRunner.run` guards what Prisma is pointed at, so the library and `buncargo prisma` share
it. Only inherited variables (the shell's, the secrets') count as foreign: whatever the config
computes or `prisma.urlEnvVar` names is buncargo's own. The squashed-chain check reads
`_prisma_migrations` the same bounded way as the deploy shortcut, and an unreadable database
lets Prisma run: a false exit 4 tells an agent to reset data it should keep.
