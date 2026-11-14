# Testing

`bun run test` runs the hermetic suite with its files in parallel (`bun test --parallel`, about
15 s); plain `bun test` runs the same suite one file after another. `bunfig.toml` preloads `scripts/test-runtime-isolation.ts`,
which keeps unit tests off the developer's machine: failing `docker` and `container` stubs first on
`PATH`, `DOCKER_HOST` pointed at nothing, a temporary `HOME` for the run, and
`BUNCARGO_WATCHDOG_PARENT`, so every watchdog a test starts ends with the run. Tests are co-located with their module as `*.test.ts`; test helpers
shared across files are `*.testing.ts` and excluded from the package. The preload also clears the
shell's `BUNCARGO_*` flags (only `BUNCARGO_TEST_*` pass through), and a test takes every port it
listens on or starts an app on from `freePorts` (`src/core/test-env.testing.ts`); the
architecture test rejects a literal or `+ 1` port.

## What CI runs

`bun run ci:local` runs the jobs of `.github/workflows/ci.yml` on this machine, reading their
commands from the workflow, with `CI=true` and `GITHUB_ACTIONS=true` set and the shell's
`BUNCARGO_*` flags removed. By default that is `lint`, `test` and `startup` (about two minutes);
a job that reaches outside the checkout runs only when named: `--job=docker` creates real
containers and writes port claims to `~/.buncargo`, `--job=frp` downloads frp and needs Go.
`--job=lint,test` runs a subset and `--list` prints the commands. The last line is `PASS` or
`FAIL: <jobs>`. It cannot run the macOS legs of a matrix, and says which jobs have one.

## Opt-in suites

These touch the network, real binaries or real runtimes, or wait out a real timer, so the default
run skips them.

| Script                                   | Variable                                   | What it proves                                                                                                       |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bun run test:integration-cloudflared`   | `BUNCARGO_TEST_CLOUDFLARED_SMOKE=1`        | A quick tunnel returns a public HTTPS URL. Cloudflare may 429; may download `cloudflared`.                            |
| `bun run test:integration-cloudflared-e2e` | `…_SMOKE=1 BUNCARGO_TEST_CLOUDFLARED_E2E=1` | `curl` through `*.trycloudflare.com` reaches the local server.                                                     |
| `bun run test:integration-hosts`         | `BUNCARGO_TEST_HOSTS=1`                    | A real mkcert mint. Needs no sudo, system trust or `:443`; may download `mkcert`.                                    |
| `bun run test:integration-proxy-idle`    | `BUNCARGO_TEST_PROXY_IDLE=1`               | The proxy keeps a quiet streamed response (SSE) open past Bun's 10s idle default. Takes ~13s: only elapsed time proves it. |
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
  `bun test` gives the run a temporary `HOME` unless an opt-in suite's flag is set; those suites
  keep the real one and must move `HOME` themselves before writing state. Inject the seams
  (`copy`, `privileged`, the reloader's edges) the modules already take.
- Wait on `sleep` for a state change. Await the event, poll the condition with a deadline, or
  inject the clock.
