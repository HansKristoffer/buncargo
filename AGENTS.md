# Buncargo Contributor Guide

## Purpose

`buncargo` is a Bun-first library/CLI for local development environments:
- Docker Compose service orchestration
- App/dev-server process orchestration
- Worktree-aware ports and project identity
- Typed config and programmatic environment access

This file defines how to structure code and how to implement changes consistently.

## Project Structure

All library source code lives under `src/`.

- `src/index.ts`
  - Public API aggregation for library consumers.
- `src/cli/`
  - CLI runtime and command handlers.
  - `bin.ts` is the CLI executable entrypoint.
  - `index.ts` is the canonical CLI module entry.
  - `run-cli.ts` contains core CLI flow; `flags.ts` (argv primitives), `dev-flags.ts` (the dev command's typed args + help), `dev-hosts.ts` and `dev-tunnels.ts` hold the pieces it orchestrates.
  - `command-spec.ts` is the flag-spec primitive: one `CommandSpec` per command drives parsing, unknown-flag detection, value validation and generated help, so those four cannot drift. Add a flag to the spec, not to a parallel list.
  - `commands/registry.ts` is the single source for top-level command names (`CliCommandName`, used by the `bin.ts` switch and by `help.ts`) and for the `hosts` subcommands. Both switches end in a `never` default.
  - Failures inside a command flow throw `CliError` (`errors.ts`) so the flow can release tunnels, host routes and the terminal before exiting 1. Argv problems, which happen before anything starts, exit through `log.fail`.
  - `log.ts` is the CLI status/error facade (`info`/`success`/`done`/`warn`/`error`/`hint`/`fail`); `src/environment/logging.ts` stays responsible for the rich environment banner.
  - `commands/` contains command-specific behavior (`dev`, `env`, `prisma`, etc.); `commands/inspect/` splits the `ls`, `status` and `doctor` commands over a shared `containers.ts`. `stop-all.ts` sits alongside them for the same container helpers but is not a command: it backs `dev --down --all`.
- `src/config/`
  - Dev config API and validation.
  - Keep definition, validation, and merge logic split by responsibility.
- `src/environment/`
  - `createDevEnvironment()` and related orchestration helpers.
  - `context.ts` resolves identity/ports/URLs once into a `DevEnvContext`; `env-vars.ts`, `lifecycle.ts`, `servers.ts` and `watchdog.ts` are built on it and `create-dev-environment.ts` only composes them.
  - `seeding.ts` owns the only seed path: `runSeedIfNeeded` backs both `start()` and `env.runSeed()` (which `buncargo dev --seed` calls with `force: true`). A failed seed fails `start()`; it does not log and continue.
  - Prefer extracting complex concerns into focused modules (e.g. logging/seeding).
- `src/loader/`
  - Config discovery/loading and cache handling.
- `src/typecheck/`
  - Workspace typecheck orchestration. `typecheck.ts` runs a real process pool (`execAsync`); `scheduling.ts` is longest-first (cached durations, then descending file count) and the CPU/CI concurrency default. The CLI spec lives in `src/cli/typecheck-flags.ts` (`--concurrency`, `--only`). Do not shell out to `bun run --filter --parallel typecheck` — Bun's workspace graph would serialize dependents.
- `src/prisma/`
  - Prisma-specific integration layer.
- `src/docker-compose/`
  - Compose generation only (model building, YAML serialization, generated-file logic).
  - `services/` contains built-in service presets/helpers.
- `src/docker/`
  - Docker runtime operations only, split by concern: `status.ts` (container/daemon checks), `lifecycle.ts` (up/down/start), `health-checks.ts`, `readiness.ts` (waits + `ensureServicesRunning`), `compose-command.ts` (`docker compose` argument building). Import through `src/docker/index.ts`.
  - `preflight.ts` detects the local Docker runtime and auto-starts it when possible.
- `src/core/`
 - Shared runtime utilities (network, ports, process, utils, watchdog).
 - `runtime-flags.ts` is the only place `BUNCARGO_*` / `CI` are read; getters take the environment as an argument.
 - `registry-file.ts` reads/writes the persisted state files (`routes.json`, `hosts-daemon.json`, `hosts-service.json`, `ports.json`, `public-tunnels.json`) through typed validators. Writes go via temp file + rename: the hosts daemon re-reads `routes.json` every second, and a truncating write would let it read the file empty and conclude there is no state.
 - `file-lock.ts` guards the state several buncargo runs share. Every read-modify-write on `routes.json` / `public-tunnels.json` must hold `withFileLock`, or two runs starting together both merge into a pre-write snapshot and the second write drops the first one's routes. The certificate is under the same lock for a different reason: minting is a `mkcert` process writing two files that the root daemon polls once a second. The lock is advisory and self-healing (dead or stalled holders are evicted, acquisition always resolves) because a dev tool must never deadlock on a lock left by a killed run.
 - `tool-binary.ts` resolves external binaries: env override, then `PATH`, then the download cache.
 - `port-allocation.ts` hashes a project offset, probes conflicts, and persists `.buncargo/ports.json`.
 - `process/` is command execution (`exec.ts`), the two-wave dev-server spawner (`dev-servers.ts`), port ownership/kill classification (`port-owner.ts`), PID lifecycle (`lifecycle.ts`) and production builds (`build.ts`), re-exported from `process/index.ts`.
  - `hosts/` is named `.localhost` HTTPS: hostname planning, user-level `~/.buncargo/routes.json`, mkcert, loopback proxy daemon, `/etc/hosts` sync, and first-run onboarding.
    - `service-files.ts` builds the launchd plist / systemd unit (pure); `privileged.ts` is the one `sudo` seam, injectable so `service.ts` can be tested without a password prompt; `service.ts` installs, removes and validates the service.
    - Installs are all-or-nothing: a unit file left behind by a failed load would make `isHostsServiceInstalled()` report success and every later run would skip setup. On failure `service.ts` removes the file it wrote.
   - `daemon-bundle.ts` owns the one file the service executes: `dist/hostsd.js`, bundled from `src/cli/hostsd.ts` and installed to `/usr/local/libexec/buncargo/hostsd-<version>.js`. The service cannot run `dist/cli/bin.js` — it is code-split across sibling chunks, it disappears when a project reinstalls dependencies, and macOS denies a root daemon any path under `~/Documents`, so launchd cannot even read it. Installing a single root-owned file answers all three and stops root executing a user-writable file.
   - The daemon runs as root under launchd/systemd, which give it a minimal `PATH` and no `HOME`. `privilegedDaemonEnv` injects `HOME` and `SUDO_*` so it reads the installing user's `~/.buncargo` and chowns what it writes back to them.
   - The daemon spawns nothing. `certificates.ts` mints the leaf in the CLI, where `mkcert` resolves the way it does interactively; the daemon polls `certificateFingerprint()`, rebinds when the CLI reminted underneath it, and reports `describeCertificateGap()` rather than shelling out as root.
   - Minting and reading the pair both go through `withFileLock` on the cert path, and `mintCert` renames the two files in (key first, cert last) instead of letting `mkcert` write them in place. Landing a pair is two steps whichever way it is done, so an unlocked daemon can bind a new certificate against the previous key and take every named URL down until the next reload.
   - `dev-hosts.ts` mints for the plan's hostnames *before* publishing them to the registry, via `syncCertificateForRoutes({ include })`. Published first, a hostname is one the daemon's next poll tries to serve with a certificate that omits it.
   - `hosts-service.json` records what the service was installed with. The bundle path carries the version it was built from, so `describeStaleHostsService()` catches both a vanished path and an upgraded CLI still pointing at the previous bundle, instead of silently degrading to `localhost:port`.
    - `runHostsDaemon` never lets a `reload()` throw escape: `KeepAlive` would respawn it forever. Failures go to `/var/log/buncargo-hosts.log` and retry on a widening backoff.
   - Only a reminted certificate rebinds the listener. `lookup` reads the live route map, so a route change needs no restart, and restarting on one would drop every proxied websocket each time an app registers or expires. That rule lives in `createHostsReloader`, which takes every edge (routes, fingerprint, proxy, `/etc/hosts`, clock, exit) as an injected dependency so it can be tested without binding a port; `runHostsDaemon` is only the composition that supplies the real ones.
   - `isProxyHealthy` probes the one scheme `readDaemonConfig().tls` says the daemon serves and validates the health body, not just the status. `ensureHostsDaemonRunning` returns early when health passes and never reaches the squatter check, so accepting any 200 on `:443` would hand the whole flow to whatever else is listening.
   - `proxy.ts` repeats the client's `sec-websocket-protocol` to the upstream and back. Vite only adopts an upgrade whose protocol is `vite-hmr`; strip it and the socket stays in Vite's HTTP server with no `error` listener, so the next reset kills the dev server with an unhandled `ECONNRESET`. For the same reason `stop()` closes bridged upstreams before the forced server stop, and an upgrade Bun refuses gets a 400 rather than being forwarded over `fetch`, which cannot finish a handshake.
- `src/types/`
  - Type surface canonical source (via `all-types.ts` + `index.ts`).

## Canonical Imports

- Prefer directory index modules over ad-hoc wrapper files.
- Canonical examples:
  - `./config/index`
  - `./environment/index`
  - `./loader/index`
  - `./typecheck/index`
  - `./types/index`
- Do not reintroduce thin top-level wrapper files that only re-export another module.

## Architectural Rules

1. Keep Docker concerns separated:
   - `src/docker-compose/*` = compose artifact generation.
   - `src/docker/*` = runtime container operations.
2. Keep modules single-purpose:
   - If a file grows large or mixes concerns, split it.
3. Keep public API stable through `src/index.ts`:
   - New public exports should be intentionally added there.
4. Keep tests co-located with code:
   - Use `*.test.ts` in the same folder as the module under test.
5. Prefer composition over monolith files:
   - Extract helpers for logging, seeding, command handling, etc.

## Coding Standards

- Use TypeScript strict mode patterns.
- Prefer small, pure helper functions where possible.
- Keep function and file names descriptive and domain-oriented.
- Use existing shared utilities before introducing new duplicates.
- Avoid hidden side effects; keep I/O boundaries explicit.
- Keep import paths aligned to the current folder architecture (no legacy root paths).
- Add comments only when logic is non-obvious.

## API and Behavior Changes

- Treat changes to `src/index.ts`, CLI command behavior, and exported types as high-impact.
- If changing behavior, update/extend tests in the same change.
- Keep error messages actionable and user-oriented.

## Validation Checklist (for every substantive change)

Run before finishing:

1. `bun run build`
2. `bun run lint:write`
3. `bun test`

If relevant, also run:

4. `bun run lint`

Do not leave the repo in a state where build/tests fail.

## Cloudflared tests (co-located)

- **[`src/cli/run-cli.test.ts`](src/cli/run-cli.test.ts)** — `runCli expose routing`: stub `DevEnvironment` and `cliTestTunnel` assert `startPublicTunnels` runs only when `--expose` is present (no cloudflared).
- **[`src/core/quick-tunnel/quick-tunnel.test.ts`](src/core/quick-tunnel/quick-tunnel.test.ts)** — **Smoke** (public HTTPS URL from `getURL()`) and **E2E** (curl through `*.trycloudflare.com`) are **opt-in**: Cloudflare quick-tunnel may **429** rate-limit; default `bun test` skips them. Set `BUNCARGO_TEST_CLOUDFLARED_SMOKE=1` for smoke; add `BUNCARGO_TEST_CLOUDFLARED_E2E=1` for E2E. First run may download `cloudflared` if missing.

Convenience scripts (only that file):

```bash
bun run test:integration-cloudflared
# smoke + E2E:
bun run test:integration-cloudflared-e2e
```

GitHub Actions: [`.github/workflows/integration-cloudflared.yml`](.github/workflows/integration-cloudflared.yml) is **workflow_dispatch** only (manual run from the Actions tab); sets `BUNCARGO_TEST_CLOUDFLARED_SMOKE=1` and `BUNCARGO_TEST_CLOUDFLARED_E2E=1`.

### Expose / cloudflared (optional env)

When using `bunx buncargo dev --expose` (Cloudflare quick tunnels), you can tune behavior:

- **`BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS`** — Milliseconds to wait between starting each exposed target (default `900`). Increase if you expose many targets and hit rate limits.
- **`BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS`** — Retries after transient tunnel errors (default `5`).
- **`BUNCARGO_QUICK_TUNNEL_RETRY_BASE_MS`** — Backoff base in ms; delay is `base × attempt` between retries (default `2000`).
- **`BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS`** — Max wait for a public `*.trycloudflare.com` URL from `cloudflared` (default `30000`; set `0` to disable the timeout).
- **`BUNCARGO_CLOUDFLARED_PATH`** — Absolute path to a `cloudflared` binary; when set, buncargo uses it and does not download into the temp cache.
- **`CLOUDFLARED_VERSION`** — GitHub release tag for the bundled download when not using `BUNCARGO_CLOUDFLARED_PATH` (default is pinned in [`src/core/runtime-flags.ts`](src/core/runtime-flags.ts); `latest` is also supported).

### Named hosts / mkcert (optional env)

When `options.hosts` is on (`bunx buncargo dev`):

- **`BUNCARGO_HOSTS`** — `0` forces `http://localhost:port` and skips the daemon (same as `--no-hosts`). CI also disables named hosts.
- **`BUNCARGO_HOSTS_PORT`** — HTTPS port the loopback proxy daemon binds (default `443`). The plain-HTTP `:80` redirect listener is only started when the default port is used.
- **`BUNCARGO_MKCERT_PATH`** — Absolute path to a `mkcert` binary; when set, buncargo uses it and does not download into the temp cache.
- **`BUNCARGO_MKCERT_VERSION`** — GitHub release tag for the bundled `mkcert` download (default `v1.4.4`).
- **`BUNCARGO_SYNC_HOSTS`** — `0` skips writing the `# buncargo-start` / `# buncargo-end` block in `/etc/hosts`.
- **`BUNCARGO_TYPECHECK_CONCURRENCY`** — Max overlapping workspace typecheck processes. Default is `availableParallelism()`, capped at 4 locally and 2 in CI.

### Reading environment flags

All `BUNCARGO_*` (plus `CI` / `CLOUDFLARED_VERSION`) reads live in [`src/core/runtime-flags.ts`](src/core/runtime-flags.ts). Add new flags there instead of reading `process.env` inline: every getter takes the environment as its last argument (defaulting to `process.env`), so tests inject a plain object and nothing is captured at import time. CI detection is `isCI()` — `CI=1|true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL` — and is the same check for named hosts, Docker auto-start, and readiness timeouts.

## Hosts tests (co-located)

- **[`src/core/hosts/plan.test.ts`](src/core/hosts/plan.test.ts)**, **[`registry.test.ts`](src/core/hosts/registry.test.ts)**, **[`proxy.test.ts`](src/core/hosts/proxy.test.ts)**, **[`hosts-file.test.ts`](src/core/hosts/hosts-file.test.ts)** — hermetic: hostname planning, route registry, Host/WS/x-forwarded/508 proxy, `/etc/hosts` block rewrite.
- **[`src/core/hosts/hosts.integration.test.ts`](src/core/hosts/hosts.integration.test.ts)** — **opt-in** mkcert mint (may download `mkcert` if missing). Default `bun test` skips it. Set `BUNCARGO_TEST_HOSTS=1`. Does **not** require sudo, system trust, or a bind on `:443`.

Convenience script:

```bash
bun run test:integration-hosts
```
