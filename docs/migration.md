# Migrating between major versions

Each section lists what a consumer of `buncargo` has to change when crossing one major version, newest first. Breaking changes that shipped inside a minor release are listed under the major you cross when you pick them up. If you are several majors behind, work through the sections from the bottom up.

## 11.0 → 12.0

12.0 is a hard cutover: the compatibility code for older versions, configs and on-disk state is gone. **Stop every run before upgrading** (`bunx buncargo dev --down --all` with the old version): 12.0 does not recognise an older run's containers or locks.

- **Worktree project names stop repeating the worktree.** A worktree in a directory named after it (`t3code-fc4fa622`) was `gey-t3code-fc4fa622-t3code-fc4fa622` and is now `gey-t3code-fc4fa622`; its E2E stack `gey-t3code-fc4fa622-e2e`. The volumes are named after the project, so each such worktree starts on an empty database: seed again, and `bunx buncargo prune` removes the old volumes. Anything that names containers by hand needs the new name; `buncargo sql` and `buncargo status --json` find them for you.
- **Offsets are claimed per checkout** in `~/.buncargo/offsets.json`. A worktree that shared its hashed offset with another may move once to the next free block, and then keeps it.
- **`options.hosts.primaryApp` is gone.** Set `options.primaryApp` instead; it also gives that app the bare named hostname.
- **`options.frontendApp`, `options.expoApiApp`, `getFrontendPort()` and `getExpoApiUrl()` are gone**, and so is `expo({ apiApp })`. Read ports and URLs from `env.ports` / `env.urls`, or `buncargo env --get`.
- **Expo needs `integrations: [expo()]`.** The per-app `expo` field is gone, and an app whose `devCommand` runs `expo` is no longer made an Expo app without the integration.
- **Removed names:** the `dev-tools` binary (use `buncargo`), the `dev-tools.config.ts` / `.js` config file names (use `dev.config.ts`), and `BUCARGO_SKIP_MKCERT` (use `BUNCARGO_HOSTS=0`).
- **Removed exports:** `spawnDevServer` (use `startDevServers`), the sync `buildApps` from `buncargo/core/process` (`buildApps` is now the async one), `logExpoApiUrl`, and the `mergeConfigs` overload taking explicit type parameters.
- **Custom container runtime adapters** must implement `containerPortOwnersAsync`, and an injected Apple CLI must implement `runAsync`.
- **Older on-disk state is not read.** Process identities without the `v2:` prefix no longer match (an older run reads as gone), the old `.lock` file protocol is ignored, and `mkcert` / `cloudflared` cached under `tmpdir()` are downloaded again into `~/.buncargo/bin`.
- **BuncargoBar installs need the release's checksum**, which every release publishes.
- **Removed config errors:** a top-level `envVars` or an app-level `env` is no longer explained by a dedicated error; use the top-level `env` overlay and `apps.<name>.staticEnv` / `envVars`.

## 10.0 → 11.0

11.0 added the terminal UI (`dev --tui`) and supervision for apps that may stop without ending the run.

- **`interactive: true` only applies in stream mode.** The TUI gives every app a terminal of its own, so it ignores the setting. Stream mode (the default, and every run without a terminal) still hands that app the TTY. `--attach=<app>` does the same for one run.
- **The Shopify CLI app is non-essential and not interactive.** Its exit no longer ends the run: it shows as stopped, and `r` in the TUI or `buncargo restart shopify` starts it again. Its `p`/`g` keys open the preview and GraphiQL URLs. Remove any `interactive: true` you added to it.
- **App output is logged.** Every run writes `.buncargo/logs/<run>/<app>.log` (the last ten runs). Keep `.buncargo/` in `.gitignore`; `buncargo setup` adds it.

## 9.0 → 10.0

Container cleanup now runs from one machine-wide sweep against one run registry (`~/.buncargo/runs.json`). It used to rely on a watchdog per project that tracked heartbeat files.

- **Upgrade every project on the machine together.** New runs record process identities in a `v2:` format that 9.x cannot read. When a 9.x CLI writes the registry, it drops every entry from the new version, including live runs, so those runs vanish from `buncargo runs` and the menu bar and lose their idle hold. Their running containers are left alone, and volumes are never touched.
- **Library `start()` now claims its run and starts the watchdog.** A `dev.start()` from a script shows up in `runs`, `stop` and the menu bar. Its containers stay up after the script exits, as long as the checkout exists, unless you request a hold with `claimRun({ idleTimeoutMs })` before `start()`. `options.autoShutdown` and the three-minute default apply to `buncargo dev` only. To skip starting the watchdog process, pass `start({ watchdog: false })`. The claim is made either way.
- **`DevEnvironment` API changed.** `startHeartbeat`, `stopHeartbeat`, `spawnWatchdog` and `stopWatchdog` are replaced by `claimRun`, `releaseRun`, `ensureWatchdog` and `sessionId`. The unread `autoShutdown` property is gone.
- **Removed exports.** The root package no longer exports `areContainersRunning`, `isContainerRunning`, `getHeartbeatFile`, `isWatchdogRunning`, `spawnWatchdog`, `startHeartbeat`, `stopHeartbeat` or `stopWatchdog`. `buncargo/docker` no longer exports `areServicesRunning`, `areContainersRunning`, `isContainerRunning` or `startService`. Use `ensureWatchdog` in place of the watchdog functions. `getWatchdogLogFile()` now takes no arguments, and the log lives in `~/.buncargo/watchdog.log` instead of `/tmp`.
- **Custom container runtime adapters.** `ContainerRuntimeAdapter` is async-only and gains `listVolumes` and `removeVolumes`. `BuncargoContainer` gains a required `state`.
- **Teardown removes containers instead of stopping them.** `dev --down --all` and stopping a whole run now bring the containers down. A stack whose checkout was deleted, or which is stopped with no owner, is removed by the sweep.
- **Containers from one-shot modes are kept longer.** `--keep-containers`, `autoShutdown: false` and the one-shot modes (`--up-only`, `--migrate`, `--seed`) set no idle hold. Their containers now live as long as the checkout, even if the run crashed.
- **Infisical defaults to the EU cloud.** `siteUrl` now defaults to `https://eu.infisical.com`, the same as `hanzio/secrets`. A project on the US cloud sets `secrets: { siteUrl: "https://app.infisical.com" }`. Secrets are now read the way hanzio reads them, as a CLI session token and then HTTP, instead of `infisical export`. The CLI must support `infisical user get token`.
- **Secrets reach commands, not only apps.** With a config-level `secrets` scope, migrations, the seed, `exec`, `prisma` and hooks' `ctx.exec` now get its values, beneath the computed env. Use `secrets: false` on an app, migration, the seed or an `exec` call to opt out. Config-level `secrets: false` disables all buncargo requests, including startup prefetch and explicit child scopes, for an offline environment. Apps now receive the same per-scope injection with machine credentials as with a CLI login. Secrets copied into `.env` for these can go.
- **Expo is an integration.** Add `integrations: [expo()]` from `buncargo/expo`. The per-app `expo` field, `options.expoApiApp`, and inferring Expo from a `devCommand` still work, with a warning, until the major after this one.
- **Volumes are never removed automatically.** To clear old worktree databases, run `bunx buncargo prune --dry-run`, then `bunx buncargo prune`.

## 8.0 → 9.0

- **Tailscale sharing is gone.** It arrived in 8.2.0 and was removed in 9.0. Remote sharing now runs over frp. The `buncargo tailnet` command and `TS_AUTHKEY` enrollment are removed, and nothing in 9.x cleans up an installed tailnet coordinator. Run `bunx buncargo tailnet uninstall` on 8.2.x before you upgrade.
- **Recipient tokens are new.** Get a token with `bunx buncargo connect token` or from BuncargoBar, and set it as `BUNCARGO_CONNECT_TOKENS`. Use comma-separated `bc_share_…` tokens (up to 16) instead of 8.0's `bc1.…` tokens or JSON array. `BUNCARGO_CONNECT_NAME` groups runs in the menu bar.
- **Sharing no longer filters on `expose`.** With tokens set, every selected app and service that has a host port is shared, and workers, jobs and portless targets are skipped. `expose: true` now only controls public `--expose` quick tunnels.

## 7.0 → 8.0

- **Tailscale removed.** The first Tailscale integration (7.7 to 7.10) is removed. That covers the `buncargo tailnet` commands, the `--tailnet` / `--no-tailnet` flags, `BUNCARGO_TAILSCALE_PATH`, and `tailnetUrls` / `setTailnetUrls` on `DevEnvironment`. Run `bunx buncargo tailnet uninstall` on 7.x first, because 8.0 does not remove the coordinator. Private sharing moved to `BUNCARGO_CONNECT_TOKENS` together with `expose: true` and the new optional `exposeProtocol: "http" | "tcp"`.

The following breaking changes shipped in 7.6.0 and were never marked as such, so you meet them on this jump:

- **Bun 1.4.2 or newer is required** (`engines.bun`, previously `>=1.0.0`). Stop running dev sessions and rerun `bunx buncargo hosts install` after upgrading, because the file-lock protocol changed and old and new processes cannot share it.
- **One-shot modes do less.** `dev --up-only` now starts containers and syncs dotenv only: no migrations, generation or seed. `--migrate` does not generate or seed. You can pass only one of `--migrate`, `--seed`, `--up-only`, `--down` and `--reset`, and `--all` requires `--down`.
- **A 404 no longer counts as healthy.** A configured `healthEndpoint` must return a success status. Point it at a real route, or set `healthEndpoint: false`.
- **Server hooks run only when servers start.** `beforeServers` and `afterServers` no longer run on preparation-only calls.
- **`docker.writeStrategy: "if-missing"` is stricter.** It now refuses an existing compose file that differs from the model. Move hand-written YAML into `service.docker` and use `"always"`.
- **The config typecheck needs a local TypeScript.** It uses the project's installed `tsc` and errors if there is none, where it used to fall back to `bunx tsc`.

## 6.0 → 7.0

- **Reinstall the named-hosts service.** The daemon now runs a bundled `hostsd` file installed under `/usr/local/libexec/buncargo`, not the CLI in `node_modules`. Run `bunx buncargo hosts install` once, and `hosts status` / `doctor` will report a stale service until you do.
- **`buncargo typecheck` behaves differently.** It runs workspaces in parallel, with concurrency set by CPU count and capped at 4 locally and 2 in CI. It also typechecks the root `dev.config.ts`, which can surface new errors. Use `--concurrency=N` or `BUNCARGO_TYPECHECK_CONCURRENCY` to throttle, and `--only=<workspace>` to narrow it. Add `.buncargo/` to `.gitignore`.

## 5.0 → 6.0

Types only. Runtime config is unchanged, but code that relied on loose types stops compiling.

- **`ComputedEnvVars` lost its open index signature.** Reading an unknown key from `buildEnvVars()` / `buildAppEnvVars()` is now a compile error. Declare the key in the top-level `env` return value or the app's `envVars` / `staticEnv`.
- **`getEnvVar` returns the overlay's declared type.** For example, it returns `number` for a `number` value, not `string | number | undefined`.
- **Option keys must name configured keys.** `options.primaryApp`, `expoApiApp`, `frontendApp`, `hosts.primaryApp`, `hosts.services`, `prisma.service` and `prisma.urlEnvVar` are typed to the config's own service, app and env names.
- **`DevConfig` and related types gained type parameters.** This includes `TEnv` on `DevConfig`, and generics on `DevOptions`, `HostsOptions`, `PrismaConfig` and `StartOptions`. Explicit annotations using these types may need updating. Prefer `typeof config` with `DevEnvironmentFor`.
- **`undefined` values are omitted.** An `env` or `envVars` value of `undefined` is left out instead of becoming the string `"undefined"`.

## 4.0 → 5.0

No consumer-facing changes: 5.0.0 is the 4.0.0 code with a new version number. 4.0.0 was never published to npm, so 3.2.5 → 5.0.0 is the real upgrade path. Follow the section below.

## 3.0 → 4.0

**Config renames.** Validation rejects the old keys with a message naming the new ones.

- Top-level `envVars` becomes `env`, with the same `(ports, urls, ctx) => ({ … })` callback. It is now an overlay on the computed values for every process, and service presets already inject `DATABASE_URL`, `REDIS_URL` and similar values.
- `apps.<name>.env` becomes `apps.<name>.staticEnv`, with the same constant map. Computed per-app values go in the new `apps.<name>.envVars`.

```ts
// before (3.x)
envVars: (ports, urls, { publicUrls }) => ({ WEB_URL: publicUrls.web ?? urls.web }),
apps: { api: { port: 3000, devCommand: "bun dev", env: { LOG_LEVEL: "debug" } } },

// after
env: (ports, urls, { publicUrls }) => ({ WEB_URL: publicUrls.web ?? urls.web }),
apps: { api: { port: 3000, devCommand: "bun dev", staticEnv: { LOG_LEVEL: "debug" } } },
```

Leave `services.<name>.env` alone: in 4.0 it is a new, different field, a map of env names to `"url" | "port" | "secondaryPort"`.

**Behavior changes.**

- **Ports move.** Every checkout, including the main one, gets a hashed offset between 100 and 9000 in steps of 100, persisted in `.buncargo/ports.json`. Postgres is no longer on `5432`. Read ports from `bunx buncargo env --get ports.<name>` or the injected env, or pin them with `BUNCARGO_PORT_OFFSET`.
- **`devCommand` runs through a shell.** It used to be split on spaces, so inline env prefixes and quoting now work. `devCommand: false` reserves a port without starting a process.
- **Running apps are reused.** An app already listening on its port is reused instead of killed.
- **Unknown CLI flags are rejected.**
- **Migrations run in order.** Configured `migrations` run one after another instead of in parallel.
- **Seeding is stricter.** A failed seed fails `start()`, where it used to log and continue. `dev --seed` without a `seed` block is now an error instead of running `bun run run:seeder`.
- **The idle timeout is shorter.** `buncargo dev` now tears containers down after 3 minutes, down from 10 (`options.autoShutdown`, `--watchdog-timeout`, `--keep-containers`).
- **Preset and option validation is stricter.** The `redis` preset no longer accepts `database`, `user` or `password`; use `service.custom()` if you need them. On a preset, `healthCheck: "tcp"` now emits no container healthcheck. `expoApiApp`, `frontendApp`, `hosts.primaryApp` and `prisma.service` must name configured keys.

**Type and API changes.**

- **`publicUrls` is narrower.** It is typed only with keys marked `expose: true`, so reading a key that is not exposed is a compile error.
- **Removed from the root export:** `getFlagValue`, `hasFlag`, `calculatePortOffset`, `killProcessOnPort`, `killProcessOnPortAndWait`, `killProcessesOnAppPorts` (use `killPortOwner`), `DOCKER_NOT_RUNNING_MESSAGE`, `MAX_ATTEMPTS` and `POLL_INTERVAL`. `isCI` is still exported.
- **Removed options:** `StartOptions.suffix`, `CliOptions.watchdogTimeout` and `CliOptions.devServersCommand`. `buncargo/core/process` is now a directory module; the import path is unchanged.
