# Secrets

`src/core/secrets/infisical.ts` fetches each Infisical scope once per process, the way
`hanzio/secrets` does, with the same defaults (EU `siteUrl`). Hanzio's public loader only returns
named keys, so it is ported here rather than depended on; sharing code needs hanzio to export an
all-keys fetch.

**Never log a value, and never echo the CLI's output or a response body in an error.** A failure
warns once and continues.

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
- The secrets are listed over HTTP (v4, imports beneath the folder's own values).
- A universal-auth identity replaces the CLI for commands (`infisicalMachineCredentials` in
  `runtime-flags.ts`). App processes still skip the fetch under a machine identity, because their
  own loaders authenticate without the CLI.

## Where they go

- `process/dev-servers.ts` injects app scopes in `startDevServers`, the one function both spawn
  paths reach, and refuses to spawn when a `secrets.required` key is missing everywhere.
- `environment/env-vars.ts` `resolveSecrets` gives `exec` (and so migrations, hooks and tasks), the
  seed and prisma their scope: explicit, else the app's, else the config-level one, always beneath
  `process.env` and the computed env.
- Startup prefetch is described in [environment](./environment.md#secrets-prefetch).
- `fake-infisical.testing.ts` is the HTTP server and CLI the tests run against (`*.testing.ts` is
  excluded from the package).
