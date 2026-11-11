# Secrets

`src/core/secrets/` fetches each Infisical folder once per process, the way `hanzio/secrets`
does, with the same defaults (EU `siteUrl`). Hanzio's public loader only returns named keys, so it
is ported here rather than depended on; sharing code needs hanzio to export an all-keys fetch and
take buncargo's machine-wide CLI lock. `scope.ts` is pure (resolution, `collectScopes`, the
`only`/`exclude` filter), `auth.ts` signs in, `fetch.ts` lists and caches, `app-secrets.ts` hands
values to apps and commands.

**Never log a value, and never echo the CLI's output or a response body in an error.** A failure
warns once and continues, except a missing session (below). There is deliberately no command that
prints a value: agents run these commands, and production credentials must stay out of their
context. `secrets ls` prints key names, `secrets check` key counts.

## Fetching

- `shared-request.ts` caches successful requests and gives each caller its own cancellation and
  timeout wait; the final waiter cancels and drains the underlying work before rejecting. CLI
  authentication shares the same lifetime across different scopes.
- The CLI session token is cached per site and binary, and a universal-auth token per site and
  identity, alongside scope fetches, and cleared by `clearScopeSecretsCache`: N scopes cost one
  sign-in and N lists. Organization exchanges stay per scope. A scope's `only` and `exclude` are
  applied after the cache, so scopes that differ only in them share one fetch. A failed `user get token` is
  not cached. A token Infisical answers 401 to (expired, or a logout elsewhere) is forgotten and
  the CLI asked once more, so a long run's later scopes do not fail on what its first one cached.
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
- A timeout and a non-zero exit cannot tell an expired session from no network, and offline
  `dev` refused to start with advice that could not help. So after the lock is released, those
  two probe `siteUrl` once without credentials (any HTTP answer counts): unreachable becomes a
  plain `SecretsError`, which warns and continues. Only a printed login prompt, an empty answer
  or a reachable site stays a login error. The site stays unreachable for 30 s, so the fetches
  after `ensureSecretsSession` fail at once instead of waiting out the CLI and the probe again.
- A 403 is never a login problem. In one project the scope lacked `organizationId`; the old
  `infisical login` advice was wrong, and every app's loader then went to the CLI at once. The
  error names the project and the token's organization and points at `secrets.organizationId`.
- An `InfisicalLoginError` stops the run instead of warning (`stopsTheRun`): every app's own
  loader and every command would wait on the same login. Not in CI, where nobody can log in, and
  not when the shell exports its own Infisical token, which the apps' loaders use while
  buncargo's CLI call strips it: both warned before this existed and still do. Its message
  carries the login command, for a library caller that prints only the message; the CLI prints
  `reason` and `login` on two lines. `ensureSecretsSession` awaits the token for each CLI
  site among a set of scopes; it is the token the fetches use (cached per site), so it costs no
  extra process. `start()` awaits it for the scopes it prefetches, before the claim; `dev` fires
  it for the selected apps' and the config-level scopes right after selection and awaits it
  before named hosts, so it
  overlaps the checks and preflight; `run` awaits it before a task's services. `exec` and a task
  without services need nothing extra: their own first fetch throws the same error just as fast.
  `loadAppSecrets` and `resolveSecrets` rethrow it rather than warn. `toCliError` turns any
  `SecretsError` into its message and `Fix:` line, which is why `errors.ts` imports nothing.
- The secrets are listed over HTTP (v4, imports beneath the folder's own values).
- A universal-auth identity (`infisicalMachineCredentials` in `runtime-flags.ts`, else the
  identity file) replaces the CLI for apps and commands alike, sharing the per-scope cache.

## Where they go

- `loadAppSecrets` prints one line per scope per process naming the keys it injects (a start loads
  them twice). A key added to the shared environment reaches every checkout on its next start; a
  Resend key once made every local sign-up send real mail, and nothing showed it. When the
  injected environment is not `dev` and matches the shell's `SECRETS_ENV`, the line is a warning.
  The default environment cannot come from the config's computed `env` overlay: scopes are
  resolved before the claim, and the overlay needs ports.

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
