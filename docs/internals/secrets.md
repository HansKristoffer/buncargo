# Secrets

`src/core/secrets/infisical.ts` fetches each Infisical scope once per process, the way
`hanzio/secrets` does, with the same defaults (EU `siteUrl`). Hanzio's public loader only returns
named keys, so it is ported here rather than depended on; sharing code needs hanzio to export an
all-keys fetch.

**Never log a value, and never echo the CLI's output or a response body in an error.** A failure
warns once and continues, except a missing session (below). There is deliberately no command that
prints a value: agents run these commands, and production credentials must stay out of their
context. `secrets ls` prints key names, `secrets check` key counts.

## Fetching

- `shared-request.ts` caches successful requests and gives each caller its own cancellation and
  timeout wait; the final waiter cancels and drains the underlying work before rejecting. CLI
  authentication shares the same lifetime across different scopes.
- The CLI session token is cached per site and binary alongside scope fetches, evicted on
  rejection, and cleared by `clearScopeSecretsCache`; organization exchanges stay per scope.
- The Infisical CLI is only asked for `infisical user get token`, under a `withFileLock` on
  `~/.buncargo/infisical-cli`, because concurrent Infisical CLI processes hang. When
  `organizationId` differs from the token's claim, the token is exchanged with
  `select-organization`, and the scoped token stays in memory so the CLI's own session is never
  switched.
- `user get token` can never become an interactive login. With an expired session the CLI starts
  its login flow ("triggering login flow", a browser callback, an email prompt) and waits for a
  person forever: agents' runs and tests hung on it until an outer `timeout`. So its stdin is
  closed, its output is matched (never kept) against the login flow's wording, which kills it at
  once, and the process gets `CLI_TIMEOUT_MS` (2 s) once it holds the lock; the lock wait is not
  counted, since worktrees queue there. Each of those, and a failed or empty answer, is an
  `InfisicalLoginError` (`errors.ts`) whose fix is `infisical login --domain=<siteUrl>`. 2 s is
  tight for the CLI's `checkAuth` round trip on a slow network; a printed prompt, the observed
  case, does not wait for it.
- An `InfisicalLoginError` stops the run instead of warning: every app's own loader and every
  command would wait on the same login. `ensureSecretsSession` awaits the token for each CLI
  site among a set of scopes; it is the token the fetches use (cached per site), so it costs no
  extra process. `start()` awaits it for the scopes it prefetches, before the claim; `dev` fires
  it for every config scope right after selection and awaits it before named hosts, so it
  overlaps the checks and preflight; `run` awaits it before a task's services. `exec` and a task
  without services need nothing extra: their own first fetch throws the same error just as fast.
  `loadAppSecrets` and `resolveSecrets` rethrow it rather than warn. `toCliError` turns any
  `SecretsError` into its message and `Fix:` line, which is why `errors.ts` imports nothing.
- The secrets are listed over HTTP (v4, imports beneath the folder's own values).
- A universal-auth identity (`infisicalMachineCredentials` in `runtime-flags.ts`, else the
  identity file) replaces the CLI for apps and commands alike, sharing the per-scope cache.

## Where they go

- `process/dev-servers.ts` injects app scopes in `startDevServers`, the one function both spawn
  paths reach, and refuses to spawn when a `secrets.required` key is missing everywhere.
  `environment/server-session.ts` runs the same check (`loadStartSecrets`) first, so the refusal
  comes before a production build or `beforeServers`; the second one reads the cache.
  `buncargo secrets ls` judges the listed scope with the same `missingKeys` over the same layers,
  computed env included, so it never disagrees with `dev` about what is missing.
- `environment/env-vars.ts` `resolveSecrets` gives `exec` (and so migrations, hooks and tasks), the
  seed and prisma their scope: explicit, else the app's, else the config-level one, always beneath
  `process.env` and the computed env.
- Startup prefetch is described in [environment](./environment.md#secrets-prefetch).
- `fake-infisical.testing.ts` is the HTTP server and CLI the tests run against (`*.testing.ts` is
  excluded from the package).
