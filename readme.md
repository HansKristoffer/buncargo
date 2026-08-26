# Buncargo

A Bun-first development environment toolkit. Define Docker services, app servers, ports, env, migrations, and tunnels in one typed `dev.config.ts`.

## Why Buncargo?

Local development environments are fragile: hand-written compose files, scattered ports, and conflicts when two checkouts run at once. Buncargo is the single source of truth. It generates Compose, allocates a unique port block per project (and per worktree), starts only the services the selected apps need, and tears containers down when the CLI is gone.

## Key Features

- **Single config file** — services, apps, ports, URLs, migrations, hooks
- **Auto-generated Docker Compose** — stamped with `buncargo.*` labels
- **Port allocation** — hash of `projectPrefix` + worktree, then probe and persist `.buncargo/ports.json`
- **Built-in presets** — Postgres, Redis, ClickHouse
- **Dev server orchestration** — reuse healthy apps, kill own orphans, fail on foreign port owners
- **Attached apps** — one process owns the TTY (Expo menus)
- **Phased public tunnels** — start backend, wait for health, open tunnels, then start apps that need `*_PUBLIC_URL`
- **Prisma integration** — `bunx buncargo prisma` with the right `DATABASE_URL`
- **Named HTTPS URLs** — opt-in `https://api.myapp.localhost` via a shared loopback proxy (mkcert + `:443`)
- **Watchdog** — owner-PID liveness plus a 3 minute idle backstop

## Quick Start

### 1. Install

```bash
bun add -d buncargo
```

### 2. Create `dev.config.ts`

```typescript
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {
		postgres: service.postgres({ database: "mydb" }),
		redis: service.redis(),
	},
	apps: {
		api: {
			port: 3000,
			devCommand: "bun run dev",
			cwd: "apps/backend",
			requiredServices: ["postgres", "redis"],
			envVars: (_ports, urls) => ({
				API_BASE_URL: urls.api,
			}),
		},
		web: {
			port: 5173,
			devCommand: "bun run dev",
			cwd: "apps/frontend",
			requiredApps: ["api"],
			envVars: (_ports, urls) => ({
				VITE_API_URL: urls.api,
			}),
		},
	},
});
```

### 3. Add scripts

```json
{
	"scripts": {
		"dev": "bunx buncargo dev",
		"dev:up": "bunx buncargo dev --up-only",
		"dev:down": "bunx buncargo dev --down",
		"dev:reset": "bunx buncargo dev --reset",
		"dev:expose": "bunx buncargo dev --expose",
		"prisma": "bunx buncargo prisma"
	}
}
```

### 4. Run

```bash
bun run dev
```

## Starter recipes

### Minimal single service

```typescript
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {
		postgres: service.postgres({ database: "myapp" }),
	},
});
```

### Monorepo API + Vite

```typescript
apps: {
	api: {
		port: 3000,
		devCommand: "bun run dev",
		cwd: "apps/api",
		healthEndpoint: "/health",
		requiredServices: ["postgres"],
	},
	web: {
		port: 5173,
		devCommand: "bun run dev",
		cwd: "apps/web",
		requiredApps: ["api"],
		envVars: (_ports, urls) => ({ VITE_API_URL: urls.api }),
	},
}
```

### API + Vite + Expo with tunnels

```typescript
expoApp: {
	port: 8081,
	cwd: "apps/expo",
	devCommand: "bunx expo start",
	interactive: true,
	needsPublicUrls: true,
	healthEndpoint: false,
	expose: true,
	requiredApps: ["api"],
	envVars: (_ports, _urls, { publicUrls }) => ({
		...(publicUrls.expoApp ? { EXPO_PACKAGER_PROXY_URL: publicUrls.expoApp } : {}),
	}),
}
```

```json
{
	"scripts": {
		"dev:with-api": "bunx buncargo dev --apps=expoApp",
		"dev:expose": "bunx buncargo dev --apps=expoApp,platform --expose"
	}
}
```

`buncargo dev --apps=expoApp -- --clear` appends `--clear` to the attached Expo command.

### Built-in service helpers

All of `service.postgres()`, `redis()`, `clickhouse()`, `mailpit()`, `typesense()` accept `port`, `expose`, `healthCheck`, `serviceName`, and `docker`. Beyond that each takes only what it honors: `database` / `user` / `password` on `postgres` and `clickhouse` (their URLs carry credentials), `secondaryPort` on `clickhouse` and `mailpit`, `apiKey` on `typesense`. Anything else is a type error — use `service.custom({ ... })` for a service that needs more.

### Custom service

```typescript
rabbitmq: service.custom({
	port: 5672,
	healthCheck: false,
	env: { RABBITMQ_URL: "url" },
	docker: {
		image: "rabbitmq:3-management-alpine",
		ports: ["${RABBITMQ_PORT:-5672}:5672"],
	},
}),
```

## CLI reference

```bash
bunx buncargo dev                 # Start containers + selected apps
bunx buncargo dev --apps=api,web  # Named apps plus transitive requiredApps
bunx buncargo dev --attach=expoApp
bunx buncargo dev --expose
bunx buncargo dev --expose=api
bunx buncargo dev --up-only
bunx buncargo dev --migrate
bunx buncargo dev --seed
bunx buncargo dev --down
bunx buncargo dev --down --all    # Stop every buncargo env on this machine
bunx buncargo dev --reset
bunx buncargo dev --keep-containers
bunx buncargo dev --watchdog-timeout=5
bunx buncargo dev --no-docker-autostart
bunx buncargo dev --no-hosts
bunx buncargo dev --apps=expoApp -- --clear
bunx buncargo ls
bunx buncargo status
bunx buncargo doctor
bunx buncargo doctor --fix
bunx buncargo hosts install
bunx buncargo hosts status
bunx buncargo hosts sync
bunx buncargo hosts prune
bunx buncargo hosts uninstall
bunx buncargo env
bunx buncargo env --get ports.api
bunx buncargo prisma <args>
bunx buncargo typecheck
bunx buncargo help
bunx buncargo version
```

`buncargo env` prints JSON (`portOffset`, `portOffsetProvenance`: `hash` | `lockfile` | `env` | `shifted`). `--get ports.api` prints one raw value for scripts.

## Startup order

```
containers + migrations + seed
        → start apps without needsPublicUrls
        → wait for their healthEndpoints (skipped when healthEndpoint: false)
        → open public tunnels when --expose is set
        → setPublicUrls / inject *_PUBLIC_URL
        → start apps with needsPublicUrls
```

`classifyCliApps` always runs: a healthy app already listening on its port is reused instead of restarted.

## Attached / interactive apps

Only one app may set `interactive: true`. `--attach=<app>` overrides it.

- Attached app: `stdio: inherit` (real TTY)
- Other apps: piped stdout/stderr with a `[name]` prefix, stdin ignored
- When the attached app exits, siblings are killed via process group
- Args after `--` are appended only to the attached command

## Ports and isolation

Non-worktree projects now get a stable nonzero offset from `projectPrefix`. Worktrees add the worktree name when `options.worktreeIsolation` is true (default).

```
BUNCARGO_PORT_OFFSET set?
  yes → use it, skip probing (provenance: env)
  no  → valid .buncargo/ports.json?
          yes → re-verify ports still free or ours (provenance: lockfile)
          no / conflict → hash projectPrefix [+ worktree] [+ suffix]
                          probe every service and app port
                          on a foreign owner, shift the whole block by 100
                          persist { version, projectName, root, offset, ports }
```

Offsets use a step of 100 in the 100–9000 range so `5432` becomes `5532` / `5632` instead of overlapping nearby defaults.

`worktreeIsolation: false` shares the compose project name **and** the offset across worktrees.

Ports still exist: processes listen on the allocated numbers, Docker publishes them, and tools like TablePlus keep using `localhost:<port>`. Named hosts are an overlay so humans and `*_URL` env vars stop typing those ports.

## Named local URLs

Opt-in HTTPS names on loopback. Buncargo still allocates ports and starts processes; a shared daemon on `:443` gives those ports hostnames.

| Checkout | App `web` | App `api` | Service `mailpit` |
| --- | --- | --- | --- |
| Main | `https://web.myapp.localhost` | `https://api.myapp.localhost` | `https://mailpit.myapp.localhost` |
| Worktree `fix-ui` | `https://fix-ui.web.myapp.localhost` | `https://fix-ui.api.myapp.localhost` | `https://fix-ui.mailpit.myapp.localhost` |

`options.hosts.primaryApp: "web"` collapses that app to `https://myapp.localhost` (or `https://fix-ui.myapp.localhost` in a worktree). The worktree label is the **directory name**, not the git branch.

Enable with `options.hosts: true` (or `{ tld?, primaryApp?, services? }`). Postgres, Redis, and other TCP services stay as connection strings on `localhost:<port>`. Default named HTTP services are Mailpit and Typesense.

The first `buncargo dev` in a repo with `hosts` on prompts for one-time machine setup (trust a local CA, bind `:443`). Enter accepts, `s` skips once, `n` persists a decline. `buncargo hosts install` is the non-interactive path. Setup is per machine: later repos and worktrees reuse it.

Failure degrades to `http://localhost:<port>` and never blocks the dev run. Named hosts stay off on Windows, in CI (`CI=1` / `CI=true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`), when `BUNCARGO_HOSTS=0`, or with `--no-hosts`.

## Environment variables

### Injected

| Variable | Where | Meaning |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | Compose / shared env | Isolated project name |
| `NODE_ENV` | Shared env | `development` unless production build |
| `<NAME>_PORT` | Shared env | Assigned port for each service/app |
| `<NAME>_URL` | Shared env | Local URL. Named HTTPS when hosts are active (`https://api.myapp.localhost`) |
| `<NAME>_PUBLIC_URL` | Shared env | Tunnel URL while a tunnel is active |
| `NODE_EXTRA_CA_CERTS` | Shared env | Path to the mkcert CA when named hosts are active |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Shared env | `.localhost` (or `.<tld>`) so Vite accepts the named Host |
| `DATABASE_URL` | Shared env | From `service.postgres()` |
| `REDIS_URL` | Shared env | From `service.redis()` |
| `CLICKHOUSE_URL` | Shared env | From `service.clickhouse()` |
| `CLICKHOUSE_NATIVE_PORT` | Shared env | ClickHouse `secondaryPort` |
| `PORT` | Per-app process | That app's assigned port |
| `HOST` | Per-app process | `0.0.0.0` |

Service `env` maps (`url` / `port` / `secondaryPort`) add more shared names. App `staticEnv` and `envVars` are injected only into that app.

### Read by buncargo

| Variable | Meaning |
| --- | --- |
| `BUNCARGO_PORT_OFFSET` | Hard port offset; skips probing |
| `BUNCARGO_EXPOSE_TUNNEL_STAGGER_MS` | Delay between starting tunnels (default `900`) |
| `BUNCARGO_QUICK_TUNNEL_MAX_ATTEMPTS` | Tunnel retries (default `5`) |
| `BUNCARGO_QUICK_TUNNEL_RETRY_BASE_MS` | Backoff base (default `2000`) |
| `BUNCARGO_QUICK_TUNNEL_TIMEOUT_MS` | Wait for a `*.trycloudflare.com` URL (default `30000`; `0` disables) |
| `BUNCARGO_CLOUDFLARED_PATH` | Absolute `cloudflared` binary; skips download |
| `BUNCARGO_HOSTS` | `0` forces `http://localhost:port` even when `options.hosts` is on |
| `BUNCARGO_HOSTS_PORT` | HTTPS port the loopback proxy daemon binds (default `443`; plain HTTP on `:80` only when the default is used) |
| `BUNCARGO_MKCERT_PATH` | Absolute `mkcert` binary; skips PATH lookup and download |
| `BUNCARGO_MKCERT_VERSION` | GitHub release tag for the bundled `mkcert` download (default `v1.4.4`) |
| `BUNCARGO_SYNC_HOSTS` | `0` skips writing the `# buncargo-start` / `# buncargo-end` block in `/etc/hosts` |
| `CLOUDFLARED_VERSION` | GitHub release tag for the bundled download |
| `CI` | Skips Docker auto-start; also disables named hosts. Detected from `CI=1` / `CI=true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL` |

Every variable above is read through [`src/core/runtime-flags.ts`](src/core/runtime-flags.ts) on each call, so a flag exported mid-session applies to the next command without a restart.

## Configuration Reference

Every field below is from `src/types/all-types.ts`. Anything not listed here is not a supported config option.

### `DevConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectPrefix` | `string` | required | Compose/project prefix. Must start with a letter and be lowercase/`0-9`/`-`. Example: `"gey"` |
| `services` | `Record<string, ServiceConfig>` | required | Docker services. At least one. |
| `apps` | `Record<string, AppConfig>` | `undefined` | Dev servers to orchestrate |
| `env` | `(ports, urls, ctx) => Record<string, string \| number>` | `undefined` | Shared overlay merged onto computed ports/urls for every process |
| `hooks` | `DevHooks` | `undefined` | Lifecycle hooks |
| `migrations` | `MigrationConfig[]` | `[]` | Extra migrate commands after containers (Prisma is auto-added when `prisma` is set). Run sequentially. |
| `seed` | `SeedConfig` | `undefined` | After migrations, before servers |
| `prisma` | `PrismaConfig` | `undefined` | Enables `dev.prisma` and `buncargo prisma` |
| `options` | `DevOptions` | `undefined` | Isolation, watchdog, helper app names |
| `docker` | `DockerComposeGenerationOptions` | `undefined` | Generated compose path, volumes, Docker auto-start |

Top-level `envVars` is removed. Use the top-level `env` overlay for shared values (rewritten `WEB_URL`, `VITE_*`), and `apps.<name>.envVars` for app-only values.

### `ServiceConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | `number` | required | Base host port before offset |
| `expose` | `boolean` | `false` | Eligible for `--expose` |
| `secondaryPort` | `number` | `undefined` | Extra host port (ClickHouse native). Exposed as `ports.<name>Secondary` |
| `healthCheck` | `"pg_isready" \| "redis-cli" \| "http" \| "tcp" \| (port) => Promise<boolean> \| false` | preset default | `tcp` is a real TCP connect from the host and emits no container healthcheck. `false` disables |
| `healthTimeout` | `number` | `30000` | Per-service health poll timeout (ms) |
| `urlTemplate` | `(ctx: UrlBuilderContext) => string` | built-in when `database`/`user`/`password` set | Connection URL builder |
| `serviceName` | `string` | the config key | Compose service name |
| `database` | `string` | preset default | Enables built-in URL template |
| `user` | `string` | `postgres` / `root` / `default` | Auth user for built-in URL |
| `password` | `string` | `postgres` / `root` / `clickhouse` | Auth password for built-in URL |
| `env` | `Record<string, "url" \| "port" \| "secondaryPort">` | preset aliases | Shared env outputs |
| `staticEnv` | `Record<string, string>` | `{}` | Constant shared env (API keys, `SMTP_HOST`) |
| `docker` | preset helper or raw Compose service | inferred for postgres/redis/clickhouse/mailpit/typesense | Image, ports, healthcheck, volumes |

`UrlBuilderContext`: `{ port, secondaryPort?, host, localIp }`.

### `AppConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `port` | `number` | required | Base host port before offset |
| `devCommand` | `string \| false` | required | Start command. `false` reserves/tunnels the port without starting a process |
| `prodCommand` | `string` | `devCommand` | Production start command |
| `buildCommand` | `string` | `undefined` | Production build command |
| `cwd` | `string` | repo root | Working directory relative to root |
| `healthEndpoint` | `string \| false` | `"/"` | HTTP path to wait on. `false` skips the wait |
| `healthTimeout` | `number` | `60000` (`120000` in CI) | App readiness timeout (ms) |
| `requiredServices` | `string[]` | `[]` | Service keys that must be up |
| `requiredApps` | `string[]` | `[]` | Apps that must also start (transitive) |
| `expose` | `boolean` | `false` | Eligible for `--expose` |
| `staticEnv` | `Record<string, string \| number>` | `{}` | Constant env for this app only |
| `envVars` | `(ports, urls, ctx) => Record<string, string \| number>` | `undefined` | Computed env for this app only |
| `interactive` | `boolean` | `false` | Own the TTY. Only one app may set this |
| `needsPublicUrls` | `boolean` | `false` | Start after tunnels so env sees `*_PUBLIC_URL` |

`envVars` context: `{ projectName, localIp, portOffset, publicUrls }`.

### `DevOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `worktreeIsolation` | `boolean` | `true` | Unique ports and compose project per worktree |
| `autoShutdown` | `number \| false` | `180000` via CLI | Idle watchdog timeout in **ms**. `false` disables (same as `--keep-containers`) |
| `verbose` | `boolean` | `true` | Default verbosity |
| `expoApiApp` | `string` | `"api"` | App key used by `getExpoApiUrl()`. Must match a configured app |
| `frontendApp` | `string` | `"platform"`, then `"web"` | App key used by `getFrontendPort()`. Must match a configured app |
| `hosts` | `boolean \| HostsOptions` | `undefined` (off) | Named `.localhost` HTTPS URLs. `true` uses TLD `localhost` and names Mailpit/Typesense. `{ tld, primaryApp, services }` for a custom TLD, collapsed primary app, or extra HTTP service UIs |

### `DockerComposeGenerationOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `generatedFile` | `string` | `.buncargo/docker-compose.generated.yml` | Path relative to root |
| `writeStrategy` | `"always" \| "if-missing"` | `"always"` | Whether to overwrite |
| `volumes` | `Record<string, DockerComposeVolumeRaw>` | `{}` | Extra top-level named volumes |
| `autoStart` | `boolean` | `true` (skipped in CI) | Try to start Docker if the daemon is down |

Generated compose includes `name: ${COMPOSE_PROJECT_NAME}` and labels `buncargo.project`, `buncargo.root`, `buncargo.worktree`, `buncargo.service`.

### `PrismaConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | `packages/prisma` | Schema directory |
| `service` | `string` | `postgres` | Service key for `DATABASE_URL` |
| `urlEnvVar` | `string` | `DATABASE_URL` | Env var name |
| `generate` | `string` | skipped | Command after migrations (e.g. `bunx prisma generate --schema ./schema --sql`) |

### `MigrationConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | required | Display name |
| `command` | `string` | required | Shell command |
| `cwd` | `string` | repo root | Working directory |

### `SeedConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `command` | `string` | required | Seeder command (`buncargo dev --seed` uses this) |
| `cwd` | `string` | repo root | Working directory |
| `check` | `(ctx) => Promise<boolean>` | always run | Return `true` to seed. `checkTable(table)` defaults its service to `prisma.service ?? "postgres"` |
| `forceExit` | `boolean` | `true` for `bun ./file.ts` commands | Exit the seed process after the module finishes, even if sockets/pools are still open |

### `DevHooks` and `HookContext`

| Hook | When |
| --- | --- |
| `afterContainersReady` | After containers are healthy |
| `beforeServers` | Before app processes start |
| `afterServers` | After health waits succeed |
| `beforeStop` | Before `stop()` |

`HookContext`: `{ projectName, ports, urls, publicUrls, exec, root, isCI, portOffset, localIp }`.

`exec(cmd, { cwd?, verbose?, env?, throwOnError? })` returns `{ exitCode, stdout, stderr }`.

### `StartOptions` / `StopOptions`

`start({ verbose, wait, startServers, productionBuild, skipSeed, skipEnvironmentLog, onlyApps, autoStartDocker })`

`stop({ verbose, removeVolumes })`

### `CliOptions` (programmatic `runCli`)

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `args` | `string[]` | `process.argv.slice(2)` | CLI flags |
| `watchdog` | `boolean` | `true` | Spawn idle watchdog. Tests set `false`. Idle timeout comes from `options.autoShutdown`, `--keep-containers`, or `--watchdog-timeout`. |

## Health Checks

| Type | Behavior |
| --- | --- |
| `pg_isready` | Postgres readiness |
| `redis-cli` | Redis `PING` |
| `http` | HTTP GET |
| `tcp` | Real TCP connect to the published port |
| function | Custom `(port) => Promise<boolean>` |
| `false` | Skip |

Raise `healthTimeout` on the service if a cold start can exceed 30s (ClickHouse often does).

App readiness uses `healthEndpoint` (HTTP). Set `healthEndpoint: false` for Metro/Expo.

Health checks always probe `http://localhost:<port>`, never the named HTTPS URL. Putting TLS and the CA on the readiness path would break reused-process detection.

## Public tunnels

Mark targets with `expose: true`, then `bunx buncargo dev --expose` or `--expose=api,web`.

Tunnels open **after** wave-1 apps are healthy and **before** `needsPublicUrls` apps spawn, so Expo can read `EXPO_PACKAGER_PROXY_URL` at start. Public URLs are normalized (trailing slash stripped).

Reuse: if an exposed app is already healthy and `.buncargo/public-tunnels.json` still has a live URL, that URL is inherited.

`--expose` still wins: `publicUrls` / `*_PUBLIC_URL` are the only public addresses. Named hosts are loopback-only.

Programmatic: `openPublicTunnels({ names?, waitForHealthy? })` then `buildAppEnvVars(name)`.

## Watchdog

The published runner lives at `dist/core/watchdog-runner.js`. Heartbeat files are `/tmp/<project>-<rootHash>-heartbeat` so two worktrees do not collide. Logs: `/tmp/<project>-<rootHash>-watchdog.log`.

- **Primary trigger:** owning CLI PID is dead (or the heartbeat file is gone) → ~15s grace → `docker compose down`
- **Idle backstop:** 3 minutes, only if the owner PID is also gone
- **Sleep safety:** a wall-clock jump > 30s resets the idle clock; the watchdog never tears down while the owner is alive
- Heartbeat every 10s, poll every 10s
- `--keep-containers` / `options.autoShutdown: false` disable it
- `--watchdog-timeout=N` sets the idle backstop in minutes

Closing the terminal sends `SIGHUP`; cleanup is awaited and idempotent.

## Troubleshooting

| Error | Cause | Fix |
| --- | --- | --- |
| `Docker is not running (…)` | Daemon down and auto-start failed/disabled | Start OrbStack/Docker/Colima, or drop `--no-docker-autostart` |
| `port 5173 held by container gey-other-platform-1 (project gey-other)` | Foreign compose project owns the port | Stop the other env (`buncargo ls` / `dev --down --all`) or let allocation shift |
| `port … held by process …` | Another process owns the port | Stop that process; own-repo orphans are killed automatically |
| `No required services resolved for app selection…` | Selected apps declare no `requiredServices` | Add `requiredServices` or start without `--apps` |
| `already listening on port … but failed health check` | Port busy but `healthEndpoint` failed | Fix the existing server or free the port |
| `Top-level envVars has been removed…` | Old config shape | Move shared values to top-level `env`, app-only values to `apps.<name>.envVars` |
| `App "…" uses "env", which was renamed to "staticEnv"…` | Old config shape | Rename `apps.<name>.env` to `apps.<name>.staticEnv` |
| `options.expoApiApp "…" must match a configured app key` | Typo or removed app | Point it at a real `apps.<name>` (same for `frontendApp`) |
| `Only one app may set interactive: true` | Two TTY owners | Keep one `interactive` or use `--attach` |
| `Watchdog did not start` | Missing `dist/core/watchdog-runner.js` | `bun run build` / reinstall the package |
| `Could not allocate a free port block` | 80 shifted blocks still conflict | Set `BUNCARGO_PORT_OFFSET` or free ports (`buncargo doctor`) |
| Named URL does not resolve / TLS warning | Daemon down or CA not trusted | `buncargo hosts status`, then `buncargo hosts install` or `doctor --fix` |
| Safari cannot open `.localhost` | `/etc/hosts` missing the names | `buncargo hosts sync` (or leave auto-sync on; `BUNCARGO_SYNC_HOSTS=0` opts out) |
| `508 Loop Detected` | Vite (or similar) proxies `/api` without rewriting Host | Add `changeOrigin: true` to the dev-server proxy config |
| `Portless is serving :443` (or Caddy / nginx / Docker) | Another proxy owns HTTPS | Stop that process, or set `hosts: false` / `--no-hosts` |

`bunx buncargo doctor` checks Docker, named port owners, stale `ports.json`, orphaned labeled containers, the tunnel registry, and the named-hosts daemon. `doctor --fix` restarts a dead daemon, re-trusts the CA, remints an expired cert, drops stale routes, and resyncs `/etc/hosts`.

## Programmatic API

```typescript
import { loadDevEnv } from "buncargo";
import type devConfig from "./dev.config";

const env = await loadDevEnv<typeof devConfig>();
console.log(env.ports.postgres, env.portOffset, env.portOffsetProvenance);
await env.start({ onlyApps: ["api"], autoStartDocker: false });
const webEnv = env.buildAppEnvVars("web");
await env.stop();
```

`loadDevEnv()` imports the config at runtime, so pass your config type (`loadDevEnv<typeof devConfig>()`) to keep the `defineDevConfig` inference — `ports`, `urls`, `getEnvVar`, and `buildAppEnvVars` stay keyed to your actual services and apps. Without it you get the widened `AnyDevEnvironment` shape, where those keys are plain strings. `getDevEnv<typeof devConfig>()` takes the same parameter.

`createDevEnvironment(config)` is the same object without going through the config loader, and infers everything from the config you pass.

## License

MIT
