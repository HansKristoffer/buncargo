# Testing

`bun test` runs the hermetic suite. `bunfig.toml` preloads `scripts/test-runtime-isolation.ts`,
which puts failing `docker` and `container` stubs first on `PATH`, so unit tests can never reach the
developer's container daemons. Tests are co-located with their module as `*.test.ts`; test helpers
shared across files are `*.testing.ts` and excluded from the package.

## Opt-in suites

These touch the network, real binaries or real runtimes, so the default run skips them.

| Script                                   | Variable                                   | What it proves                                                                                                       |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bun run test:integration-cloudflared`   | `BUNCARGO_TEST_CLOUDFLARED_SMOKE=1`        | A quick tunnel returns a public HTTPS URL. Cloudflare may 429; may download `cloudflared`.                            |
| `bun run test:integration-cloudflared-e2e` | `…_SMOKE=1 BUNCARGO_TEST_CLOUDFLARED_E2E=1` | `curl` through `*.trycloudflare.com` reaches the local server.                                                     |
| `bun run test:integration-hosts`         | `BUNCARGO_TEST_HOSTS=1`                    | A real mkcert mint. Needs no sudo, system trust or `:443`; may download `mkcert`.                                    |
| `bun run test:integration-hosts-soak`    | `BUNCARGO_TEST_HOSTS_SOAK=1`               | Several worktrees activate in parallel, repeatedly, and every hostname attaches every time. See below.               |
| `bun run test:integration-apple`         | `BUNCARGO_TEST_APPLE_CONTAINER=1`          | The live Apple `container` runtime (macOS 26+, Apple silicon).                                                       |
| `bun run test:integration-frp`           | `BUNCARGO_TEST_FRP=1`                      | frp publishing end to end.                                                                                           |
| `bun run test:integration-shopify-cli`   | `BUNCARGO_TEST_SHOPIFY_CLI=1`              | The Shopify CLI bundle strings buncargo depends on, in 3.x and 4.x.                                                  |
| `bun scripts/verify-docker.ts`           |                                            | Disposable Docker contracts (container reuse), run by the dedicated CI job.                                          |
| `bun run verify:package`                 |                                            | The release tarball installs and works in a clean consumer.                                                          |

The worktree soak exists for the failure a single run almost never shows: a hostname that
"sometimes" does not attach in a worktree, leaving the run on `localhost:port` with no error. It
runs against a real reloader, real file locking and a real mint. Reverting either the tolerant
route wait or the bind-before-stop rebind makes it fail (3 of 20 activations fell back), which is
what makes it a regression test rather than one that always passes.

`.github/workflows/integration-cloudflared.yml` runs both cloudflared suites on manual dispatch
only.

## Never

- Run the sweep, the watchdog or `dev --down --all` against an isolated `HOME` while the real
  container runtime is reachable. Every real stack on the machine then looks unowned. Stub the
  adapters, or point `DOCKER_HOST` at nothing as well.
- Write to the real `~/.buncargo`, `/etc/hosts`, the clipboard or the installed hosts service.
  Point `HOME` at a temporary directory and inject the seams (`copy`, `privileged`, the reloader's
  edges) the modules already take.
- Wait on `sleep` for a state change. Await the event, poll the condition with a deadline, or
  inject the clock.
