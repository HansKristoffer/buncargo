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
  - `takeover.ts` answers the dead end where every selected app was already running: the run used to print "nothing to start" and exit, leaving the developer to find the other window. It prompts, and on `y` (or `--takeover`) stops those ports' owners and spawns them here. Reuse stays the default and a bare Enter declines, because taking over kills servers in a terminal the developer may not be looking at. Only apps with a `devCommand` are candidates — stopping the port of one buncargo does not spawn would leave it down instead of moving it. The other run tears itself down safely: `releaseNamedHosts` drops only routes carrying its own pid, and `stopHeartbeat` hands the containers to the watchdog's idle backstop rather than stopping them. The decision is made *before* `logSelectedAppsSummary` and the banner, so both describe the run that actually happens and the reclaimed hostnames are the ones printed. `run-cli.ts` then calls `activateNamedHosts` a second time: the first attempt was refused because the other run still owned the hostnames, and `upsertHostRoutes` only rejects an owner that is still alive, so the retry succeeds once that pid is gone. Without it a takeover silently downgrades every named URL to `localhost:port`.
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
 - `buildComposeModel` takes the *resolved* `ContainerRuntimeName`, not the configured selection, because `docker.runtime` may still say `"auto"` at that point. It exists for the few places the runtimes genuinely differ: the postgres preset sets `PGDATA` to a subdirectory on Apple, whose named volumes are formatted block devices carrying a `lost+found` that `initdb` refuses. Docker's are plain directories, and moving them would hide every existing project's database behind an empty one. A preset that branches on this for anything cosmetic is not worth the ambiguity it adds to the generated model.
- `src/container-runtime/`
 - The runtime-neutral seam, and the canonical import for everything outside the two backends.
 - `types.ts` is the `ContainerRuntimeAdapter` port. `ContainerUpRequest` carries both `composeFile` and `model` because they are one artifact seen two ways: Docker hands the file to `docker compose`, Apple walks the model. Deriving the model separately per backend would let the two drift.
 - `resolve.ts` is the precedence: `--runtime`, then `BUNCARGO_CONTAINER_RUNTIME`, then `config.docker.runtime`, then `"docker"`. Only `"auto"` probes; an explicit choice is returned even when its daemon is down, so the failure surfaces as that runtime's own remediation instead of a silent switch to the other one — the two keep their volumes in different places.
 - There is one `binary` override for two backends, so it only means anything once a runtime is chosen: `resolveContainerRuntimeBinary` returns nothing under `"auto"`, config validation rejects the pairing outright, and `availableContainerRuntimes` applies the path only to the runtime named alongside it. Otherwise probing for Apple's `container` would mean executing whatever `docker` was pinned to, and reporting the wrong one down.
 - `ExecInServiceRequest.command` is argv, not a shell command line, so neither backend has to quote it and the two cannot disagree about which shell runs a probe. Both backends spawn argv throughout; the only surviving shell is `command -v` in `src/docker/preflight.ts`, which is a builtin with nothing to exec.
 - `diagnoseService` is why a dead container fails in about two seconds instead of after the full readiness timeout. `readiness.ts` calls it every eighth poll, and only a state in `isTerminalContainerState` aborts — matched positively so a state neither backend has shown us yet keeps polling rather than killing a startup that would have worked. `logTail` is enrichment: a backend that cannot produce it returns empty and the state alone still fails fast.
 - `ensureServicesRunning` calls `up()` **every** run, including when the services are already up, because that is the only place either backend compares a running container against the config it was started from. Skipping it made an edited image, port or env var take effect only after a manual `--down`, and left Apple's `buncargo.config-hash` label with nothing to do. `areServicesRunning` survives only to compute the `started` flag and to quiet the reconcile pass; a recreate announces itself regardless.
 - `ContainerDownRequest.model` is optional because containers are found by label. Only `removeVolumes` needs it, to name the volumes, which is why the detached watchdog runner can tear a project down without loading its config.
 - `readiness.ts` and `health-checks.ts` are the polling loop and the built-in probes, both driven through the adapter. `pg_isready` / `redis-cli` go through `adapter.execInService`; `http` / `tcp` hit the published host port and are runtime-independent by construction.
 - `inventory.ts` backs the machine-wide commands (`ls`, `doctor`, `dev --down --all`). Those have no project config in scope, so they ask every available runtime rather than one.
 - `containerRuntimeForEnv()` is how a caller holding a finished `DevEnvironment` rebuilds its adapter. The runtime name and the resolved binary have to travel together, so going through the name alone would silently drop a configured `docker.binary` in `status`, `doctor` and prisma.
 - A port held by the *other* backend is invisible to the selected one, so the diagnostic degraded to the daemon that owns the socket: switching a project to Apple with a Docker container still up reported `com.docker.backend` rather than the container's own name. `getPortOwner`'s `fallbackRuntimes` asks the other runtimes only after the selected one comes back empty, and only from `assertServicePortsClaimable` and `doctor` — the two places that report the failure. `killPortOwner` polls ten times a second and deliberately does not pay for it. The adapters are passed in rather than resolved in `core/`, which would make `core/process` import the runtimes that import it back.
 - `PortContainerOwner.runtime` is what stops a cross-runtime container being classified `reuse`: it carries this project's own name, but this run cannot start, exec into or tear it down through the backend it selected. `formatPortOwner` names the backend only when it differs from the selected one, and does so *after* the noun — `containerRuntimeDisplayName` is a product name, so "Apple container" cannot qualify "container".
- `src/docker/`
 - Docker runtime operations only, split by concern: `status.ts` (container/daemon checks), `lifecycle.ts` (up/down/start), `compose-command.ts` (`docker compose` argument building), `inventory.ts` (`docker ps` listing), `port-lookup.ts` (published-port owner). `adapter.ts` is a factory binding them to the port, taking the same `{ binary }` as Apple's.
 - `binary.ts` is the one place the `docker` command name is spelled. Every command builder here goes through it, so `docker.binary` reaches all of them rather than only the ones somebody remembered.
 - `preflight.ts` detects the local Docker runtime and auto-starts it when possible.
- `src/apple-container/`
 - The Apple `container` backend, for macOS 26+ on Apple silicon. Apple has said Docker CLI/compose compatibility is not a project goal, so this translates the generated model into per-container commands instead of swapping a command prefix.
 - `run-plan.ts` is a **pure** `ComposeDocument` → argv translation, which is why it carries most of the tests. It also does compose's `${VAR:-default}` substitution itself: the model writes port bindings as `${POSTGRES_PORT:-5432}` on the assumption that `docker compose` interpolates the file, and Apple's CLI does not. `interpolate` matches every form in one pass, which is what makes `$$` an escape rather than a `$` a second pass could re-read.
 - `SILENTLY_DROPPED_KEYS` is `healthcheck`, `depends_on` and `restart`: the three the preset builders emit on every service. Warning on those would fire on every run and teach people to ignore the warning that matters, which is worse than the gap it reports. Everything else a user hand-wrote is reported.
 - `--entrypoint` takes one command, so compose's list form splits: head to the flag, tail ahead of `command` in the container's arguments. Joining the list would ask Apple to exec a binary literally named `/bin/sh -c`.
 - `command` and `entrypoint` both go through `commandWords`, because compose splits their string form into words. Passing the string through whole hands the image one long argument: the typesense preset writes `command` as a string, and unsplit it printed its usage and exited instead of starting. The split is `splitCommandLine`, which honors quotes and backslashes — splitting on whitespace alone turns `sh -c "echo hi"` into four broken tokens.
 - `interpolate` keeps compose's colon distinction: `${VAR:-d}` replaces an empty value, `${VAR-d}` keeps it, and `${VAR:?msg}` / `${VAR?msg}` fail with the author's message. Collapsing the two would substitute a default over a variable somebody deliberately set to empty.
 - `container_name` is in the *warned* set, not the translated one. The container is always `<project>-<service>` so exec, reuse and teardown agree on one name; honoring a user-set value would mean threading a second name through all three, for a key buncargo's own presets never emit.
 - Each container carries a `buncargo.config-hash` label, so `up` can tell "mine and still matching" (start it) from "config changed underneath it" (recreate) rather than throwing away a warm data volume on every run.
 - `cli.ts` is the only place the binary is executed, and is injectable so `lifecycle.ts` and `status.ts` are tested without the runtime installed.
 - `status.ts` reads `container ls --all --format json` once and filters client-side: Apple's `ls` has no `--filter`. Its JSON shape has moved between releases, so each field is read defensively rather than against a fixed schema.
 - `preflight.ts` auto-starts via `container system start` but never passes `--enable-kernel-install`: with it, a first run would install a kernel without asking; without it, the command prompts and would hang a non-interactive spawn.
- `src/core/`
 - Shared runtime utilities (network, ports, process, utils, watchdog).
 - `runtime-flags.ts` is the only place `BUNCARGO_*` / `CI` are read; getters take the environment as an argument.
 - `registry-file.ts` reads/writes the persisted state files (`routes.json`, `hosts-daemon.json`, `hosts-service.json`, `ports.json`, `public-tunnels.json`) through typed validators. Writes go via temp file + rename: the hosts daemon re-reads `routes.json` every second, and a truncating write would let it read the file empty and conclude there is no state. A read is lenient by default and `strict` for a consumer that only reads: a missing file is "no state yet", but an unreadable one is state we cannot see, and the daemon must fail rather than serve an empty world. Writers stay lenient — they can repair the file, while throwing would strand them behind one only a human could delete.
 - `file-lock.ts` guards the state several buncargo runs share. Every read-modify-write on `routes.json` / `public-tunnels.json` must hold `withFileLock`, or two runs starting together both merge into a pre-write snapshot and the second write drops the first one's routes. The certificate is under the same lock for a different reason: minting is a `mkcert` process writing two files that the root daemon polls once a second. The lock is advisory and self-healing (dead or stalled holders are evicted, acquisition always resolves) because a dev tool must never deadlock on a lock left by a killed run.
 - `tool-binary.ts` resolves external binaries: env override, then `PATH`, then the download cache. That cache is `~/.buncargo/bin`, not `tmpdir()`, which macOS purges — a vanished `mkcert` takes named hosts down on the next run that has to widen the certificate. The old `tmpdir()` path is still read so an existing binary is adopted rather than downloaded again.
  - `port-allocation.ts` hashes a project offset, probes conflicts, and persists `.buncargo/ports.json`. `probeConflicts: false` turns the probe off for a read: `getEnvVar` answers a `vite.config.ts` with the ports the environment is *using*, and cannot resolve a runtime without importing the backends that import it back, so probing there would read this project's own service container as foreign and shift the block onto a port nothing is listening on. It takes the resolved runtime for the same reason the readiness check does: asking Docker about a port an Apple container published reports the `container` forwarder process, which classifies as a foreign occupant and shifts the offset by `PORT_OFFSET_STEP`. A shifted port changes the generated model, which changes Apple's `buncargo.config-hash`, so every run recreated its own containers and alternated between two ports. A container of ours on the *other* backend must still shift — that port really is taken.
 - `process/` is command execution (`exec.ts`), the two-wave dev-server spawner (`dev-servers.ts`), port ownership/kill classification (`port-owner.ts`), PID lifecycle (`lifecycle.ts`) and production builds (`build.ts`), re-exported from `process/index.ts`.
 - `isProcessAlive` counts `EPERM` as alive. It is the ordinary answer when an unelevated CLI asks about the root hosts daemon, and only `ESRCH` means gone. Reading `EPERM` as dead had a dev run break the daemon's registry lock the moment it held one — the exact race the lock exists to prevent — and prune every route the daemon owned.
  - `hosts/` is named `.localhost` HTTPS: hostname planning, user-level `~/.buncargo/routes.json`, mkcert, loopback proxy daemon, `/etc/hosts` sync, and first-run onboarding.
    - `service-files.ts` builds the launchd plist / systemd unit (pure); `privileged.ts` is the one `sudo` seam, injectable so `service.ts` can be tested without a password prompt; `service.ts` installs, removes and validates the service.
    - Installs are all-or-nothing: a unit file left behind by a failed load would make `isHostsServiceInstalled()` report success and every later run would skip setup. On failure `service.ts` removes the file it wrote.
   - `daemon-bundle.ts` owns the one file the service executes: `dist/hostsd.js`, bundled from `src/cli/hostsd.ts` and installed to `/usr/local/libexec/buncargo/hostsd-<version>.js`. The service cannot run `dist/cli/bin.js` — it is code-split across sibling chunks, it disappears when a project reinstalls dependencies, and macOS denies a root daemon any path under `~/Documents`, so launchd cannot even read it. Installing a single root-owned file answers all three and stops root executing a user-writable file.
   - The daemon runs as root under launchd/systemd, which give it a minimal `PATH` and no `HOME`. `privilegedDaemonEnv` injects `HOME` and `SUDO_*` so it reads the installing user's `~/.buncargo` and chowns what it writes back to them.
   - The daemon spawns nothing. `certificates.ts` mints the leaf in the CLI, where `mkcert` resolves the way it does interactively; the daemon polls `certificateFingerprint()`, rebinds when the CLI reminted underneath it, and reports `describeCertificateGap()` rather than shelling out as root.
   - Minting and reading the pair both go through `withFileLock` on the cert path, and `mintCert` renames the two files in (key first, cert last) instead of letting `mkcert` write them in place. Landing a pair is two steps whichever way it is done, so an unlocked daemon can bind a new certificate against the previous key and take every named URL down until the next reload.
   - `dev-hosts.ts` mints for the plan's hostnames *before* publishing them to the registry, via `syncCertificateForRoutes({ include })`. Published first, a hostname is one the daemon's next poll tries to serve with a certificate that omits it. `activateNamedHosts` returns its warnings rather than printing them: a run that goes on to take over another one activates twice, and the first failure — the other run still owning the hostnames — is one the second attempt undoes, so printing it there would have the banner contradict it three lines later.
   - `hosts-service.json` records what the service was installed with. The bundle path carries the version it was built from, so `describeStaleHostsService()` catches both a vanished path and an upgraded CLI still pointing at the previous bundle, instead of silently degrading to `localhost:port`. It also records the bundle's content hash, because the path stops at the version: a rebuild during development passes every path comparison while running code that no longer matches the CLI. Either side being unknown means "cannot compare", never "stale".
    - `runHostsDaemon` never lets a `reload()` throw escape: `KeepAlive` would respawn it forever. Failures go to `/var/log/buncargo-hosts.log` and retry on a widening backoff.
   - Only a reminted certificate rebinds the listener. `lookup` reads the live route map, so a route change needs no restart, and restarting on one would drop every proxied websocket each time an app registers or expires. That rule lives in `createHostsReloader`, which takes every edge (routes, fingerprint, proxy, `/etc/hosts`, clock, exit) as an injected dependency so it can be tested without binding a port; `runHostsDaemon` is only the composition that supplies the real ones.
   - `isProxyHealthy` probes the one scheme `readDaemonConfig().tls` says the daemon serves and validates the health body, not just the status. `ensureHostsDaemonRunning` returns early when health passes and never reaches the squatter check, so accepting any 200 on `:443` would hand the whole flow to whatever else is listening. Do **not** gate it on `routes > 0`: the daemon binds before any route exists, and a fresh machine would report itself down and fall through to the squatter path.
 - The listener and the reload loop fail independently, so health alone proves nothing about routing: a loop that stops leaves `Bun.serve` answering 200 while every named URL 404s against a frozen map. `lastReloadAt` travels in the health body, the proxy notices a stale map **from the request path** (a timer-based watchdog would die with the timers it watches), and the daemon reloads in-band before falling back to `process.exit(1)` for `KeepAlive` to restart. On the CLI side `waitForDaemonRoutes` is what stands between the registry and the banner — a route is a file until the daemon picks it up, and advertising it earlier is how https URLs come to point at our own 404. A daemon that reports no `hostnames` is unverifiable, not failing.
   - `proxy.ts` repeats the client's `sec-websocket-protocol` to the upstream and back. Vite only adopts an upgrade whose protocol is `vite-hmr`; strip it and the socket stays in Vite's HTTP server with no `error` listener, so the next reset kills the dev server with an unhandled `ECONNRESET`. For the same reason `stop()` closes bridged upstreams before the forced server stop, and an upgrade Bun refuses gets a 400 rather than being forwarded over `fetch`, which cannot finish a handshake.
   - Both `Bun.serve` calls in `startLocalProxy` set `idleTimeout: 0`. A proxy has no say in how often its upstream speaks, and Bun's 10s default counts a quiet streamed response as idle, so it resets SSE, oRPC Event Iterators and idle HMR sockets mid-body — the browser reports that as `ERR_INCOMPLETE_CHUNKED_ENCODING` on a request that already returned 200. Anything that keep-alives less often than 10s (oRPC defaults to 15s, tuned for hosted proxies) dies before its first ping. Do not answer this by shortening the app's keep-alive; the proxy is what is wrong.
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
- **`BUNCARGO_CLOUDFLARED_PATH`** — Absolute path to a `cloudflared` binary; when set, buncargo uses it and does not download into `~/.buncargo/bin`.
- **`CLOUDFLARED_VERSION`** — GitHub release tag for the bundled download when not using `BUNCARGO_CLOUDFLARED_PATH` (default is pinned in [`src/core/runtime-flags.ts`](src/core/runtime-flags.ts); `latest` is also supported).

### Named hosts / mkcert (optional env)

When `options.hosts` is on (`bunx buncargo dev`):

- **`BUNCARGO_HOSTS`** — `0` forces `http://localhost:port` and skips the daemon (same as `--no-hosts`). CI also disables named hosts.
- **`BUNCARGO_HOSTS_PORT`** — HTTPS port the loopback proxy daemon binds (default `443`). The plain-HTTP `:80` redirect listener is only started when the default port is used.
- **`BUNCARGO_MKCERT_PATH`** — Absolute path to a `mkcert` binary; when set, buncargo uses it and does not download into `~/.buncargo/bin`.
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
