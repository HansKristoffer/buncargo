# Environment and preparation

`createDevEnvironment()` lives in `src/environment/`. `context.ts` resolves identity, ports and URLs
once into a `DevEnvContext`; `env-vars.ts`, `lifecycle.ts`, `servers.ts` and `run-claim.ts` are
built on it, and `create-dev-environment.ts` only composes them. Extract a complex concern into a
focused module (logging, seeding) rather than growing the composition.

## Seeding

`seeding.ts` owns the only seed path: `runSeedIfNeeded` backs both `start()` and `env.runSeed()`
(which `buncargo dev --seed` calls with `force: true`). A failed seed fails `start()`; it does not
log and continue. `seed-startup.ts` shares selection for `seed.beforeApps: false`; any selected
`afterPreparation` service forces the serial path. `server-session.ts` owns the concurrent seed
task, cancellation and draining across CLI and library, including production builds and empty
sessions kept open for tunnels. The CLI defers the automatic seed through
`skipSeed`/`prefetchSeed`, and `server-session.ts` joins the seed before `afterServers` and
readiness. Concurrent output uses `process/prefix-output.ts`.

## Secrets prefetch

`prefetch-secrets.ts` starts the distinct selected scopes immediately after startup preparation,
except in containers-only mode. Consumers await the shared cache and own their warn-once
messages. Prefetch cancellation releases the CLI lock; failed startup drains fetches. The
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
