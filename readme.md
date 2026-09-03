# Buncargo

A Bun-first development environment toolkit. Define Docker services, app servers, ports, env, migrations, and tunnels in one typed `dev.config.ts`.

![BuncargoBar showing a running project, its apps and services](https://raw.githubusercontent.com/HansKristoffer/buncargo/main/buncargo-topbar.png)

*[BuncargoBar](#buncargobar), the optional menu bar app: every running project, worktree, app and service - open a URL, copy a connection string, or stop one of them.*

## Why Buncargo?

Local development environments are fragile: hand-written compose files, scattered ports, and conflicts when two checkouts run at once. Buncargo is the single source of truth. It generates Compose, allocates a unique port block per project (and per worktree), starts only the services the selected apps need, and tears containers down when the CLI is gone.

## Key Features

- **Single config file** - services, apps, ports, URLs, migrations, hooks
- **Auto-generated Docker Compose** - stamped with `buncargo.*` labels
- **Port allocation** - hash of `projectPrefix` + worktree, then probe and persist `.buncargo/ports.json`
- **Built-in presets** - Postgres, Redis, ClickHouse
- **Dev server orchestration** - reuse healthy apps, kill own orphans, fail on foreign port owners
- **Attached apps** - one process owns the TTY (Expo menus)
- **Phased public tunnels** - start backend, wait for health, open tunnels, then start apps that need `*_PUBLIC_URL`
- **Prisma integration** - `bunx buncargo prisma` with the right `DATABASE_URL`
- **Named HTTPS URLs** - opt-in `https://api.myapp.localhost` via a shared loopback proxy (mkcert + `:443`)
- **Watchdog** - owner-PID liveness plus a 3 minute idle backstop
- **Run registry + menu bar app** - every active run in `~/.buncargo/runs.json`, surfaced by `buncargo runs` and BuncargoBar

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

All of `service.postgres()`, `redis()`, `clickhouse()`, `mailpit()`, `typesense()` accept `port`, `expose`, `healthCheck`, `serviceName`, and `docker`. Beyond that each takes only what it honors: `database` / `user` / `password` on `postgres` and `clickhouse` (their URLs carry credentials), `secondaryPort` on `clickhouse` and `mailpit`, `apiKey` on `typesense`. Anything else is a type error - use `service.custom({ ... })` for a service that needs more.

Health check defaults follow what each image can actually run: `pg_isready` on postgres, `redis-cli` on redis, in-container HTTP on clickhouse, and `tcp` on mailpit and typesense, whose images ship no `wget` or `curl` to probe with. A `tcp` check emits no Compose healthcheck and is polled from the host instead.

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
bunx buncargo dev --takeover        # Stop apps running elsewhere, run them here
bunx buncargo dev --keep-containers
bunx buncargo dev --watchdog-timeout=5
bunx buncargo dev --no-docker-autostart
bunx buncargo dev --no-hosts
bunx buncargo dev --runtime=apple  # Run services on Apple container
bunx buncargo dev --timing         # Print how long each startup phase took
bunx buncargo dev --apps=expoApp -- --clear
bunx buncargo ls
bunx buncargo runs                # What is running on this machine
bunx buncargo runs --json         # Same, machine-readable
bunx buncargo stop api            # Stop one dev server
bunx buncargo stop postgres       # Stop one service's container
bunx buncargo stop --all          # Stop this checkout's whole run
bunx buncargo status
bunx buncargo doctor
bunx buncargo doctor --fix
bunx buncargo hosts install
bunx buncargo hosts status
bunx buncargo hosts sync
bunx buncargo hosts prune
bunx buncargo hosts daemon      # Run the proxy in the foreground
bunx buncargo hosts uninstall
bunx buncargo bar install         # Install the macOS menu bar app
bunx buncargo bar status
bunx buncargo env
bunx buncargo env --get ports.api
bunx buncargo prisma <args>
bunx buncargo typecheck
bunx buncargo help
bunx buncargo version
```

`buncargo env` prints JSON (`portOffset`, `portOffsetProvenance`: `hash` | `lockfile` | `env` | `shifted`). `--get ports.api` prints one raw value for scripts.

`buncargo typecheck` runs each workspace's own `typecheck` script in parallel (longest job first), plus the root `dev.config.ts` on its own - that file belongs to no workspace, so nothing else checks it. Default concurrency is the CPU count, capped at 4 locally and 2 in CI; override with `--concurrency=N` or `BUNCARGO_TYPECHECK_CONCURRENCY`. `--only=platform` (path or basename) checks one workspace. The config run generates `.buncargo/config-typecheck.tsconfig.json` and records durations in `.buncargo/typecheck-timings.json`; keep `.buncargo/` in `.gitignore`.

## Container runtime

Services run on Docker by default. On macOS 26 or later on Apple silicon they can run on [Apple `container`](https://github.com/apple/container) instead, which boots each container in its own lightweight VM with no Docker Desktop.

```ts
export default defineDevConfig({
  projectPrefix: "myapp",
  docker: { runtime: "auto" },
  services: { postgres: { port: 5432 } },
});
```

The selection is read from `--runtime`, then `BUNCARGO_CONTAINER_RUNTIME`, then `docker.runtime`, then the `"docker"` default. `"auto"` uses Apple `container` when its system service answers and falls back to Docker otherwise; an explicit `"apple"` fails with instructions rather than silently switching, because the two runtimes keep their volumes in different places.

Everything else is unchanged: the same `dev.config.ts`, the same generated compose file, the same `ls` / `status` / `doctor` / `--down --all` output, and the same named `.localhost` URLs. Apple's CLI has no compose support, so buncargo translates the generated service model into one `container run` per service, matching on the `buncargo.*` labels both backends write.

**Requirements.** macOS 26+ on Apple silicon, with `container system start` having been run once (the first run installs a kernel and needs a terminal, so buncargo will not do it for you).

**Known gaps** compared with the Docker backend:

- `restart:` policies are dropped - Apple has no equivalent. This changes nothing in practice: buncargo starts containers per `dev` run and the watchdog stops them, so no restart policy is part of the contract either backend offers.
- Compose `healthcheck:` blocks are dropped. This also changes nothing: readiness is buncargo's own poll against the published host port, not compose's `--wait`.
- Any other compose key that cannot be translated is listed in a warning rather than silently ignored.
- **No DNS between containers.** Every Apple container joins one builtin `default` network (`192.168.64.0/24`), so containers can already reach each other by IP. Resolving each other by *name* needs `container system dns create`, which must run as an administrator; buncargo keeps a single deliberate `sudo` seam for the hosts daemon and does not add a second one. Note also that a container's hostname is `<project>-<service>` (for example `myapp-main-postgres`), not the compose service name. Apps on the host are unaffected - they reach services on `localhost:<port>` either way, which is how buncargo wires them already.
- Bind-mounting a host directory into an image that `chown`s it fails on virtiofs. The built-in presets all use named volumes, which are unaffected.

`service.postgres()` needs no special handling: Apple's named volumes are formatted filesystems, so a fresh one already contains `lost+found` and `initdb` refuses to use it as a data directory, and on this runtime the preset points `PGDATA` at a subdirectory of the mount for you. Docker's named volumes start empty and keep the mount root, so an existing project's data stays where it is.

## Startup speed

`bun dev` is run constantly, in many worktrees, so the work before the first dev server starts is kept small:

- **One reading of the machine's ports per phase.** Port ownership is asked in four places (allocation, service preflight, app classification, spawning); a single `lsof` and one container listing answer all of them, instead of a fork per port per question.
- **The container reconcile is skipped when nothing changed.** Every generated service carries a `buncargo.stack-hash` label covering its interpolated definition. If all the selected services are already running with this run's hash, `docker compose up` is not called at all; anything that would change a container changes the hash, so an edited image or port still takes effect without `--down`.
- **Nothing blocks on the idle watchdog.** It is spawned alongside the dev servers rather than waited on.
- **No shelling out to find a binary.** `PATH` and mkcert's CA root are read directly.

`bunx buncargo dev --timing` (or `BUNCARGO_TIMING=1`) prints where the time actually went:

```
Startup
  hosts           124ms
  containers      412ms
  app ports        38ms
  total           581ms
```

## Startup order

```
containers + migrations + seed + envFile sync
        → start apps without needsPublicUrls
        → wait for their healthEndpoints (skipped when healthEndpoint: false)
        → open public tunnels when --expose is set
        → setPublicUrls / inject *_PUBLIC_URL
        → start apps with needsPublicUrls
```

`needsPublicUrls` only splits the waves when `--expose` is actually passed. On a plain `bunx buncargo dev` there is no tunnel URL to wait for, so those apps start in the first wave and get health-checked like everything else - one static config is correct either way, with no need to inspect `process.argv`.

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

Both steps need your password: the CA goes into the system trust store, and only root may bind `:443` or write the launchd/systemd unit. Setup is all-or-nothing - if the service fails to load, buncargo removes the unit file rather than leave a half-installed machine that skips setup on the next run. Setup is skipped without a TTY, since the password prompt would hang.

Certificates cover wildcards, not just the exact hostnames: a project serving `api.myapp.localhost` also gets `*.api.myapp.localhost` and `*.myapp.localhost`, so the *next* worktree of that project needs no new certificate. That matters because minting one makes the daemon rebind, which drops every proxied websocket on the machine - including HMR sockets belonging to projects that had nothing to do with the new worktree. The names each checkout wants are remembered in `~/.buncargo/cert-names.json` so a project stopping does not drop its coverage; an entry is retired once its checkout is gone from disk.

The daemon picks up a new route as soon as the registry file changes rather than on its next poll, and hands over between listeners without closing the port, so starting a run in a fresh worktree does not race it.

`buncargo hosts install` records what it installed in `~/.buncargo/hosts-service.json`. The daemon runs whichever buncargo started it, usually the one in a project's `node_modules`, so reinstalling dependencies there can leave the machine-wide service pointing at a path that no longer exists - and upgrading buncargo leaves it running the previous version's daemon bundle. Either way it keeps answering on `:443`, so `buncargo dev` prompts to update it (Enter updates, `s` skips this run) rather than waiting for you to notice; without a TTY it warns and continues on the old daemon. `buncargo hosts status` and `buncargo doctor` report the same thing, and `buncargo hosts install` or `doctor --fix` repairs it outright.

The daemon logs to `/var/log/buncargo-hosts.log` (on Linux, also `journalctl -u buncargo-hosts.service`). A failure that persists is logged at most once a minute, with a count of what was suppressed, so a stale daemon retrying a certificate it cannot serve cannot fill the disk.

`buncargo hosts daemon` runs that same proxy in the foreground instead of under launchd/systemd, which is how you watch its output while debugging. It re-reads `~/.buncargo/routes.json` every second, so apps starting and stopping need no restart, and it exits on its own once no routes have been registered for a while. `--service` is what the installed unit passes: it keeps the daemon alive through idle periods and is not meant to be typed by hand. Binding `:443` still needs root, so run it under `sudo` or set `BUNCARGO_HOSTS_PORT` to an unprivileged port.

Failure degrades to `http://localhost:<port>` and never blocks the dev run. Named hosts stay off on Windows, in CI (`CI=1` / `CI=true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`), when `BUNCARGO_HOSTS=0`, or with `--no-hosts`.

### Loopback URLs

Some clients cannot follow a named HTTPS URL: Playwright does not trust the local CA, the Stripe CLI fails the HTTP→HTTPS redirect, and GUI database clients want a plain connection string. Enabling `hosts` rewrites `urls.<name>` in place, so those consumers get `loopbackUrls` instead - the same set of services and apps, always addressed as `http://localhost:<port>`.

It is available everywhere the URLs are: `env.loopbackUrls`, the `env()` and `envVars()` context, `HookContext`, the `<NAME>_LOOPBACK_URL` env var, and `buncargo env --get loopbackUrls.api` for shell scripts. There is no `<app>Local` member - that key is the LAN IP, a different address for a different purpose (mobile devices on the network).

```typescript
// playwright.config.ts
const env = JSON.parse(execSync("bunx buncargo env").toString());
export default defineConfig({ use: { baseURL: env.loopbackUrls.web } });
```

## Run registry and the menu bar app

Every `buncargo dev` publishes itself to `~/.buncargo/runs.json`: project,
worktree, branch, pid, and each app and service with its URL, public tunnel and
state. It is written when the run starts, patched as servers become ready, and
removed on teardown; entries whose owner process is gone are pruned on read.

```bash
bunx buncargo runs          # grouped by project, main checkout first
bunx buncargo runs --json   # the same data, for scripts and agents
```

Unlike `ls`, this needs no container runtime, so it answers instantly and works
with Docker stopped.

### Stopping one thing

```bash
bunx buncargo stop api        # SIGTERM that dev server's process group
bunx buncargo stop postgres   # docker/container stop for that service
bunx buncargo stop --all      # the whole run, containers included
```

Stopping one app does not end the run: a signalled exit is not a failure to the
child supervisor, so the other apps and the containers keep going. Two targets
are refused without `--force` (and prompt when there is a terminal): the
attached app, because closing it tears the run down by design, and an app this
run reused from another terminal, because that process is not ours. Exit codes
are `0` stopped, `2` no such target, `3` refused.

Services are stopped, never killed, so a `restart:` policy cannot undo it.
Nothing in buncargo brings a stopped container back - the watchdog only ever
tears down - so it stays down until the next `dev`.

### BuncargoBar

A macOS menu bar app over the same registry, for when the run you want is in a
terminal window you closed three worktrees ago.

Projects are headers and each checkout is a row - `Main`, or the worktree name
with its branch beneath - so several worktrees of one project stack up under it.
Only running checkouts appear. **Open** launches the primary app; the chevron
opens a panel with every app and service, each with open, copy, a TablePlus
button for databases, and a stop button. **Stop run** stops everything.

It is a reader: it never signals a process or talks to Docker, it shells out to
`buncargo stop` using the exact interpreter that started the run, so a worktree
on a different buncargo version stops with its own build. See
[`menubar/README.md`](menubar/README.md).

```bash
bunx buncargo bar install
```

`buncargo dev` offers it once, the first time it runs on a Mac without it:
Enter installs, `s` skips this run, `n` never asks again. The offer is silent on
Linux and Windows, in CI, without a TTY, under `BUNCARGO_BAR=0`, and whenever
the named-hosts setup already asked something this run - one setup question per
run, at most.

## Dotenv sync

buncargo injects the right environment into processes it spawns, but `bun test`, an ad-hoc `bun run` and Playwright read `.env` off disk. Because the port offset is a hash of the project name and shifts again per worktree, a hand-written `localhost:5432` is stale by construction.

```typescript
options: {
  envFile: true,                              // .env
  // envFile: { path: ".env", createFrom: ".env.example" }
}
```

It runs once containers are ready and before migrations, since Prisma reads `.env` itself. The rules are deliberately conservative, so the file stays the repo's contract rather than buncargo's dump:

- Only keys **already in the file** are touched; an absent key is never added, and a missing file is only created when you set `createFrom`.
- A value is only replaced when it is empty, a bare port number, or already on `localhost` / `127.0.0.1`. A deliberate override - a cloned remote database, a shared staging service - survives untouched.
- Comments, ordering, quoting, `export` prefixes and spacing are preserved byte for byte.
- Values come from the **loopback** URLs, never the named `https://` hosts.
- Keys buncargo cannot derive - a second connection string for the same database, a URL with a path suffix - come from `values`, which is handed the ports and the loopback URLs and nothing else:

```typescript
envFile: {
  path: ".env",
  createFrom: ".env.example",
  values: (ports, loopbackUrls) => ({
    DATABASE_URL_PGBOUNCER: loopbackUrls.postgres,
    API_URL: `${loopbackUrls.api}/api`,
  }),
}
```
- The write lands through a temp file and a rename, so a test runner loading `.env` concurrently never sees it truncated.

## Environment variables

### Injected

| Variable | Where | Meaning |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | Compose / shared env | Isolated project name |
| `NODE_ENV` | Shared env | `development` unless production build |
| `<NAME>_PORT` | Shared env | Assigned port for each service/app |
| `<NAME>_URL` | Shared env | Local URL. Named HTTPS when hosts are active (`https://api.myapp.localhost`) |
| `<NAME>_LOOPBACK_URL` | Shared env | Always `http://localhost:<port>`, never rewritten by named hosts |
| `<NAME>_PUBLIC_URL` | Shared env | Tunnel URL while a tunnel is active |
| `NODE_EXTRA_CA_CERTS` | Shared env | Path to the mkcert CA when named hosts are active |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Shared env | `.localhost` (or `.<tld>`) so Vite accepts the named Host |
| `DATABASE_URL` | Shared env | From `service.postgres()` |
| `REDIS_URL` | Shared env | From `service.redis()` |
| `CLICKHOUSE_URL` | Shared env | From `service.clickhouse()` |
| `CLICKHOUSE_NATIVE_PORT` | Shared env | ClickHouse `secondaryPort` |
| `PORT` | Per-app process | That app's assigned port |
| `HOST` | Per-app process | `0.0.0.0` |
| `BUNCARGO_APP_NAME` | Per-app process | The app's key in `apps`, so a framework plugin knows which app it is |
| `BUNCARGO_APP_HOSTNAME` | Per-app process | That app's named host (only when named hosts are active) |

Service `env` maps (`url` / `port` / `secondaryPort`) add more shared names. App `staticEnv` and `envVars` are injected only into that app.

### Vite plugin

`buncargoVite()` configures the Vite dev server from the variables above, which removes the three things a Vite app in a buncargo repo otherwise hand-writes:

```ts
// apps/web/vite.config.ts
import { buncargoVite } from "buncargo/vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [buncargoVite(), react()],
});
```

It sets `server.port` from `PORT`, binds `server.host` to `127.0.0.1` (Vite's default `localhost` resolves to `[::1]` on many systems, so anything dialing IPv4 gets a refused connection), passes the named-hosts suffix through to `server.allowedHosts`, and - only when `BUNCARGO_APP_HOSTNAME` is set - points `server.hmr` at `wss://<hostname>:<hosts port>` so the HMR socket follows the HTTPS page rather than the raw Vite port.

Vite is not a dependency of buncargo: the plugin's return type is declared structurally, so importing it costs nothing in a repo without Vite. Override the app or the bind address when you need to: `buncargoVite({ app: "web", host: "0.0.0.0" })`.

### Read by buncargo

| Variable | Meaning |
| --- | --- |
| `BUNCARGO_PORT_OFFSET` | Hard port offset; skips probing |
| `BUNCARGO_CONTAINER_RUNTIME` | `docker` \| `apple` \| `auto`; overrides `docker.runtime` |
| `BUNCARGO_CONTAINER_BINARY` | Absolute path to the selected runtime's binary; skips the PATH lookup. `docker.binary` wins over it |
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
| `BUNCARGO_TYPECHECK_CONCURRENCY` | Max overlapping workspace typecheck processes (positive integer) |
| `BUNCARGO_TIMING` | `1` prints a per-phase breakdown of `dev` startup (same as `--timing`) |
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
| `needsPublicUrls` | `boolean` | `false` | Start after tunnels so env sees `*_PUBLIC_URL`. Ignored without `--expose` |

`envVars` context: `{ projectName, localIp, portOffset, publicUrls, loopbackUrls }`.

### `DevOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `worktreeIsolation` | `boolean` | `true` | Unique ports and compose project per worktree |
| `autoShutdown` | `number \| false` | `180000` via CLI | Idle watchdog timeout in **ms**. `false` disables (same as `--keep-containers`) |
| `envFile` | `boolean \| { path?, createFrom? }` | `false` | Sync a dotenv to the allocated ports. `true` means `.env` |
| `verbose` | `boolean` | `true` | Default verbosity |
| `primaryApp` | `string` | inferred | The app this project is "about": the menu bar's Open button, and the default for `hosts.primaryApp` and `frontendApp`. Inferred from the dependency graph when unset |
| `expoApiApp` | `string` | `"api"` | App key used by `getExpoApiUrl()`. Must match a configured app |
| `frontendApp` | `string` | `primaryApp`, then `"platform"`, then `"web"` | App key used by `getFrontendPort()`. Must match a configured app |
| `hosts` | `boolean \| HostsOptions` | `undefined` (off) | Named `.localhost` HTTPS URLs. `true` uses TLD `localhost` and names Mailpit/Typesense. `{ tld, primaryApp, services }` for a custom TLD, collapsed primary app, or extra HTTP service UIs |

### `DockerComposeGenerationOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `generatedFile` | `string` | `.buncargo/docker-compose.generated.yml` | Path relative to root |
| `writeStrategy` | `"always" \| "if-missing"` | `"always"` | Whether to overwrite |
| `volumes` | `Record<string, DockerComposeVolumeRaw>` | `{}` | Extra top-level named volumes |
| `autoStart` | `boolean` | `true` (skipped in CI) | Try to start Docker if the daemon is down |
| `runtime` | `"docker" \| "apple" \| "auto"` | `"docker"` | Which container runtime runs the services (see [Container runtime](#container-runtime)) |
| `binary` | `string` | PATH lookup | Absolute path to the selected runtime's binary (`docker` or `container`) |

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

Tunnels open **after** wave-1 apps are healthy and **before** `needsPublicUrls` apps spawn, so Expo can read `EXPO_PACKAGER_PROXY_URL` at start. Public URLs are normalized (trailing slash stripped). Without `--expose` there is no second wave at all.

Reuse: if an exposed app is already healthy and `.buncargo/public-tunnels.json` still has a live URL, that URL is inherited.

`--expose` still wins: `publicUrls` / `*_PUBLIC_URL` are the only public addresses. Named hosts are loopback-only.

Programmatic: `openPublicTunnels({ names?, waitForHealthy? })` then `buildAppEnvVars(name)`.

## Watchdog

The published runner lives at `dist/core/watchdog-runner.js`. Heartbeat files are `/tmp/<project>-<rootHash>-heartbeat` so two worktrees do not collide. Logs: `/tmp/<project>-<rootHash>-watchdog.log`.

- **Crashed owner:** the CLI PID is dead, or the heartbeat file is gone → ~15s grace → `docker compose down`
- **Clean exit:** Ctrl-C leaves a `released` marker instead, and containers are held for the full idle backstop so the next `dev` reuses them rather than recreating them
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
| `Named-hosts service points at … which no longer exists` | The install ran from a `node_modules` that was since removed | `buncargo hosts install` to re-point it at the current CLI |
| `Named-hosts service is installed but did not answer on :443` | Daemon started and crashed | `tail /var/log/buncargo-hosts.log`, then `buncargo hosts install` |
| `… is still owned by root` | A `sudo` run wrote a file under `~/.buncargo` and could not hand it back | `sudo chown -R "$USER" ~/.buncargo` |
| `Named hosts need one-time setup` with no prompt | No TTY, so the password prompt was skipped | Run `buncargo hosts install` from a terminal |
| Safari cannot open `.localhost` | `/etc/hosts` missing the names | `buncargo hosts sync` (or leave auto-sync on; `BUNCARGO_SYNC_HOSTS=0` opts out) |
| `508 Loop Detected` | Vite (or similar) proxies `/api` without rewriting Host | Add `changeOrigin: true` to the dev-server proxy config |
| `Portless is serving :443` (or Caddy / nginx / Docker) | Another proxy owns HTTPS | Stop that process, or set `hosts: false` / `--no-hosts` |

`bunx buncargo doctor` checks the container runtime, named port owners, stale `ports.json`, orphaned labeled containers, the tunnel registry, and the named-hosts daemon and service install. If the runtime this project selected is down, doctor starts it the same way `dev` would - Docker Desktop, OrbStack, Colima, or `container system start` - and only reports it when that fails or when running in CI. `doctor --fix` restarts a dead daemon, re-trusts the CA, reinstalls a stale service, remints an expired cert, drops stale routes, and resyncs `/etc/hosts`. The fixes that need a password are skipped without a TTY.

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

`loadDevEnv()` imports the config at runtime, so pass your config type (`loadDevEnv<typeof devConfig>()`) to keep the `defineDevConfig` inference - `ports`, `urls`, `getEnvVar`, and `buildAppEnvVars` stay keyed to your actual services and apps. Without it you get the widened `AnyDevEnvironment` shape, where those keys are plain strings. `getDevEnv<typeof devConfig>()` takes the same parameter.

`createDevEnvironment(config)` is the same object without going through the config loader, and infers everything from the config you pass.

## License

MIT
