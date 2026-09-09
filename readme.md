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

Buncargo requires Bun 1.4.2 or newer on macOS or Linux (WSL on Windows).

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
	envVars: (ports, _urls, { localIp, publicUrls }) => ({
		// Metro inlines EXPO_PUBLIC_* from its own environment, so this
		// belongs on the Expo app. The LAN IP works in the simulator and on a
		// phone on the same network.
		EXPO_PUBLIC_API_URL: `http://${localIp}:${ports.api}`,
		...(publicUrls.expoApp ? { EXPO_PACKAGER_PROXY_URL: publicUrls.expoApp } : {}),
	}),
}
```

An app whose `devCommand` mentions `expo` (or sets `expo: true`) gets `RCT_METRO_PORT`, so each worktree's Metro listens on its own port instead of asking for 8081. See [Expo and the iOS simulator](#expo-and-the-ios-simulator).

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
bunx buncargo dev --timing         # Entry through app readiness, including preparation
bunx buncargo dev --timing-json    # Same measurements and numeric counters as JSON
bunx buncargo dev --apps=expoApp -- --clear
bunx buncargo ls
bunx buncargo runs                # What is running on this machine
bunx buncargo runs --json         # Same, machine-readable
bunx buncargo stop api            # Stop one dev server
bunx buncargo stop postgres       # Stop one service's container
bunx buncargo stop --all          # Stop this checkout's whole run
bunx buncargo sim                 # Open the Expo app in this checkout's own simulator
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
bunx buncargo exec -- bun scripts/maintenance.ts
bunx buncargo exec --app=api -- bun scripts/inspect-runtime.ts
bunx buncargo prisma <args>
bunx buncargo typecheck
bunx buncargo help
bunx buncargo version
```

`buncargo env` prints JSON (`portOffset`, `portOffsetProvenance`: `hash` | `lockfile` | `env` | `shifted`). `--get ports.api` prints one raw value for scripts.

`buncargo typecheck` runs each workspace's own `typecheck` script in parallel (longest job first), plus the root `dev.config.ts` on its own - that file belongs to no workspace, so nothing else checks it. Default concurrency is the CPU count, capped at 4 locally and 2 in CI; override with `--concurrency=N` or `BUNCARGO_TYPECHECK_CONCURRENCY`. `--only=platform` (path or basename) checks one workspace. The config run generates `.buncargo/config-typecheck.tsconfig.json` and records durations in `.buncargo/typecheck-timings.json`; keep `.buncargo/` in `.gitignore`.

## Execute with the checkout environment

Use `exec` for maintenance scripts and tooling that need the checkout's allocated
URLs and environment:

```sh
bunx buncargo exec -- bun scripts/maintenance.ts
bunx buncargo exec --app=api -- bun scripts/inspect-runtime.ts
bunx buncargo exec --cwd=packages/prisma -- bun seed.ts --profile=internal
```

Shared generated values are always available. `--app` adds that app's environment
overlay and uses its configured directory; otherwise the working directory is the
repository root. An explicit relative `--cwd` resolves from that root, including
when the command is launched inside a workspace.

The required `--` separates buncargo options from unchanged child arguments.
Invoke a shell explicitly for shell syntax, for example `-- sh -c 'command1 && command2'`.
Standard streams, interrupt signals and the child's exit status propagate to the
caller. Exec does not start apps or infrastructure, migrate, generate, or seed.

Exec, Prisma and environment reads reuse persisted checkout ports without probing
running services as foreign occupants. On a cold checkout, they compute a
deterministic allocation without starting infrastructure or writing the allocation;
those endpoints are a preview until `dev` resolves conflicts and persists them.
Read-only commands retain existing persisted endpoints across base-port edits;
new keys use the persisted offset until startup reconciles. An explicit
`BUNCARGO_PORT_OFFSET` overrides allocation.

Programmatically, `env.exec(["bun", "scripts/maintenance.ts"], { app: "api", cwd: "." })`
uses the same environment and directory rules. String commands use a shell; argv
arrays preserve each argument. It returns `{ exitCode, stdout, stderr }` and throws
on failure unless `throwOnError: false` is supplied.

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

Both backends use `dev.config.ts`, the generated Compose model, inspection commands and named `.localhost` URLs. Apple's CLI has no compose support, so buncargo translates the generated service model into one `container run` per service, matching on the `buncargo.*` labels both backends write.

**Requirements.** macOS 26+ on Apple silicon, with `container system start` having been run once (the first run installs a kernel and needs a terminal, so buncargo will not do it for you).

**Known gaps** compared with the Docker backend:

- `restart:` policies are dropped - Apple has no equivalent. This changes nothing in practice: buncargo starts containers per `dev` run and the watchdog stops them, so no restart policy is part of the contract either backend offers.
- Compose `healthcheck:` and `depends_on:` ordering are not translated. Buncargo still runs its configured published-port probes; portless containers use process-state readiness. Use Docker when container dependencies require Compose health/completion conditions.
- Finite jobs (`kind: "job"`) require Docker. Apple selections containing a job fail before startup mutations because that backend cannot verify job exit codes.
- Any other compose key that cannot be translated is listed in a warning rather than silently ignored.
- **No DNS between containers.** Every Apple container joins one builtin `default` network (`192.168.64.0/24`), so containers can already reach each other by IP. Resolving each other by *name* needs `container system dns create`, which must run as an administrator; buncargo keeps a single deliberate `sudo` seam for the hosts daemon and does not add a second one. Note also that a container's hostname is `<project>-<service>` (for example `myapp-main-postgres`), not the compose service name. Apps on the host are unaffected - they reach services on `localhost:<port>` either way, which is how buncargo wires them already.
- Bind-mounting a host directory into an image that `chown`s it fails on virtiofs. The built-in presets all use named volumes, which are unaffected.

`service.postgres()` needs no special handling: Apple's named volumes are formatted filesystems, so a fresh one already contains `lost+found` and `initdb` refuses to use it as a data directory, and on this runtime the preset points `PGDATA` at a subdirectory of the mount for you. Docker's named volumes start empty and keep the mount root, so an existing project's data stays where it is.

## Startup speed

`buncargo dev --timing` (or `BUNCARGO_TIMING=1`) measures startup from CLI entry through successful app readiness. `--timing-json` emits one JSON record with `totalMs`, `phases`, and numeric `counters`. Reports also appear on startup failure; credentials and command contents are not included. Phase durations can overlap; “entry to first app spawn” is a cumulative milestone.

Warm startup skips container reconciliation only when every selected service is running with its matching `buncargo.service-hash`. Service fingerprints include effective environment values, user labels, and referenced volume definitions, and remain stable when an unrelated service joins or leaves the selection. External build/env-file inputs and unresolved Compose interpolation trigger reconciliation because equality cannot be proven.

App readiness is polled every 200 ms. Container commands and probes are asynchronous and cancellable, and app health checks run concurrently. An explicit `healthEndpoint` requires a successful HTTP status; `healthEndpoint: false` explicitly disables that check. Port ownership uses one snapshot per phase, and unchanged generated files are not rewritten.

For reproducible overhead measurements, run `bun run build` followed by `bun scripts/benchmark-startup.ts --samples=10 --parallel=1`. Use `--parallel=5` or `--parallel=20` for contention. The fixture uses real CLI/app processes and a fake runtime; it excludes image pulls, real database readiness, migrations, HTTPS, and external tunnel latency. See [implementation and validation](docs/startup-reliability-implementation.md) for measured results and limits.

## Startup order

```
validate selected apps, dependencies, attachment, and expose targets
  → activate named hosts for dev
  → start early selected containers, wait for service readiness and job completion
  → sync envFile → beforeMigrations → migrations → optional generation → container hook → seed
  → start afterPreparation containers and wait for readiness
  → beforeServers → spawn wave 1 → wait for wave 1 health
  → open requested tunnels and inject public URLs
  → spawn wave 2 → wait for wave 2 health → afterServers
```

`needsPublicUrls` splits waves only with `--expose`. `requiredApps` expands the selection; it does not promise readiness ordering between apps in the same wave. Healthy existing apps are reused. Both CLI and library server startup call server hooks once; `start({ startServers: false })` performs preparation without server hooks.

| Command | Work |
| --- | --- |
| `dev` | Containers, migrations, generation, seed, apps, readiness |
| `dev --up-only` | Containers and dotenv sync; no migrations, generation, seeds, or apps |
| `dev --migrate` | Early containers, dotenv sync, bootstrap and migrations; no generation, seeds, late containers, or apps |
| `dev --seed` | Selected containers and preparation, including bootstrap and forced seed; no apps |
| `dev --down` / `--reset` | Stop; reset also removes volumes |

Mutually exclusive modes cannot be combined. Configuration, selection, dependency
references and cycles are validated before startup changes host configuration or
starts resources.

### App-only selections

Use `services: {}` for a project with no containers. In a mixed config, an app
without `requiredServices` can start independently of the container-backed apps:

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
  projectPrefix: "example",
  services: { postgres: service.postgres() },
  apps: {
    marketing: {
      port: 4321,
      cwd: "packages/marketing",
      devCommand: "bun run dev",
    },
    api: {
      port: 3000,
      cwd: "packages/api",
      devCommand: "bun run dev",
      requiredServices: ["postgres"],
    },
  },
});
```

`bunx buncargo dev --apps=marketing` allocates its app port, injects its environment
and supervises the process without resolving a container runtime, writing Compose,
or starting/stopping containers. Named hosts and tunnels remain available when
configured. Explicit diagnostic and shutdown commands can inspect configured
infrastructure.

A partial app-only start refuses a port conflict that would relocate an unselected
persisted service. Free the conflicting port or start the full environment to
reconcile its shared allocation.

### Portless workers

Use `kind: "worker"` for a long-running process without an HTTP listener:

```ts
apps: {
  jobs: {
    kind: "worker",
    cwd: "packages/jobs",
    devCommand: "bun run dev",
    requiredServices: ["postgres"],
    staticEnv: { QUEUE_NAME: "local" },
  },
},
```

Workers require a command and reject `port`, `expose`, `healthEndpoint` and Expo
configuration. They receive shared environment values and app overlays, but have
no generated `PORT`, `HOST`, allocated port or URL. Inherited or explicitly
configured environment values still apply. Computed port/URL types omit workers.

Worker readiness means spawned and still alive; it does not prove a connection to
a queue or database. An unexpected exit, including zero, fails supervision.
Deliberate stops remain clean. Library startup keeps supervising after returning
PIDs; cancellation and `env.stop()` clean up owned process groups.

The CLI reuses a live worker in the same checkout. `dev --takeover` explicitly
stops it and starts it in the current run. Direct library startup refuses a
duplicate worker. Ownership uses PID and process birth identity, so simultaneous
starts cannot create duplicate consumers and worktrees stay separate. Workers
appear in logs and the run registry; `buncargo stop jobs --run=<session>` stops an
owned worker. A reused worker must be stopped through its owning run.

### Portless containers and finite jobs

Omit `port` for an internal container: it has no host publication or generated URL.
Buncargo waits for the runtime to report it running. That establishes process
startup; use Docker Compose health conditions for stronger container dependencies.
Host endpoint options and host-derived environment mappings require a port.

Use a job for a finite container command. This example imports fixture data after
database preparation:

```ts
services: {
  postgres: service.postgres(),
  importData: {
    kind: "job",
    rerun: "always",
    afterPreparation: true,
    healthTimeout: 60_000,
    docker: {
      image: "postgres:16",
      environment: { PGPASSWORD: "postgres" },
      volumes: ["./scripts/import.sql:/setup/import.sql:ro"],
      command: ["psql", "-h", "postgres", "-U", "postgres", "-f", "/setup/import.sql"],
      depends_on: { postgres: { condition: "service_healthy" } },
    },
  },
},
apps: {
  api: {
    port: 3000,
    devCommand: "bun run dev",
    requiredServices: ["importData"],
  },
},
```

`requiredServices` selects the job; Compose dependencies select PostgreSQL too.
Compose references use `serviceName` when it differs from the config key.
A container depending on a job uses `condition: "service_completed_successfully"`.
Completion references must target jobs; `service_healthy` cannot target a job.

A running job is not complete. Exit zero satisfies completion; nonzero exit
prevents subsequent preparation/apps from starting and reports recent job output.
Jobs cannot publish ports, expose endpoints or set restart policies. Completion
requires Docker; Apple rejects job selections before starting resources.

`rerun: "always"` is required and is the only supported policy. First startup runs
the job; later startups rerun completed or failed jobs. Configuration changes
reconcile the container, and volume resets run initialization again. An already
running matching job is awaited. The consumer must make repeated execution safe.
Late startup does not rerun jobs already completed in the early phase.

### Selection-aware preparation

Declare service prerequisites on migrations and seeders to scope their side effects:

```ts
prisma: { service: "postgres", cwd: "packages/prisma" },
hooks: {
  beforeMigrations: async (ctx) => {
    await ctx.exec(["bun", "scripts/bootstrap-roles.ts"]);
  },
},
migrations: [{
  name: "extra-schema",
  command: "bun scripts/migrate.ts",
  requiredServices: ["postgres"],
}],
seed: {
  command: "bun scripts/seed.ts",
  requiredServices: ["postgres"],
},
```

| Preparation | Selection rule |
| --- | --- |
| Automatic Prisma migration/generation | `prisma.service`, default `postgres`, must be selected |
| Migration/seed with `requiredServices` | Every listed service must be selected |
| Migration/seed without prerequisites | Runs when at least one service is selected |
| Migration/seed with `requiredServices: []` | Also permitted in app-only runs |
| `beforeMigrations` | Selected Prisma database; without Prisma configuration, any selected service |
| `afterContainersReady` | Runs after migration/generation, before seeding, when services are selected |

`beforeMigrations` runs after early container readiness and job completion, before
automatic Prisma migrations and ordered custom migrations. Hooks, generation
checks and seed checks receive expanded `selectedApps` and `selectedServices`.
`ctx.exec` uses the migration environment and carries cancellation; pass
`ctx.signal` to custom I/O. Bootstrap or migration failure prevents later work.
Bootstrap/migration success is not cached by configuration hash.

Set `afterPreparation: true` on a service that needs migrations or seed data before
starting. It starts after generation, `afterContainersReady` and seed, and must be
ready before apps start. Early services cannot depend on late ones, and migration,
seed or Prisma prerequisites cannot require late services. Independent containers
within a phase and apps within a wave run concurrently. `requiredApps` expands
selection only; it does not create per-app or host-to-container readiness barriers.

Containers-only mode skips all preparation hooks, migrations, generation and seed.
`dev --migrate` runs bootstrap and migrations through the same lifecycle path.
Direct `buncargo prisma <args>` is a Prisma passthrough with the database environment;
it does not run development bootstrap hooks or the complete preparation/seed lifecycle.
Startup failure and cancellation retain shared-container ownership rules instead
of tearing down other runs' resources.

## Attached / interactive apps

Only one app may set `interactive: true`. `--attach=<app>` overrides it.

- Attached app: `stdio: inherit` (real TTY)
- Other apps: piped stdout/stderr with a `[name]` prefix, stdin ignored
- When the attached app exits, siblings are killed via process group
- Args after `--` are appended only to the attached command

## Expo and the iOS simulator

Expo Go and a development build are shells: the JavaScript comes from whichever Metro a deep link names. So two worktrees of an Expo app are two Metro ports plus two simulator devices, one per checkout, each opened on its own port. One device cannot hold two installs of the same bundle ID, but two devices can run side by side.

```bash
bunx buncargo dev --apps=expoApp   # Expo attached, Metro on this worktree's port
bunx buncargo sim                  # in another terminal, or the phone button in BuncargoBar
```

`buncargo sim` reads the run registry, so it needs no config and no Docker. It

1. finds or creates this checkout's device, named `<projectPrefix>/<worktree> · iPhone 16 Pro`, by cloning the simulator you last used in Simulator.app (or `expo.simulator`), so the development build installed there comes along;
2. boots it and brings Simulator.app to the front;
3. waits for Metro to listen on the app's port;
4. opens the development build when it is installed on that device, else Expo Go, on `127.0.0.1:<port>`.

If neither is installed on the device it says so: press `shift+i` in the Expo terminal and pick the device, or run `npx expo run:ios --device "<name>"` once. Expo CLI's plain `i` opens on the first booted device, which with two worktrees up is not always yours.

```typescript
expoApp: {
	devCommand: "bun run start",      // does not say "expo", so:
	expo: {
		scheme: "myapp",               // default: `scheme` in app.json, else exp+<slug>
		simulator: "iPhone 17 Pro",    // default: the device Simulator.app last showed
	},
}
```

The deep-link scheme and `ios.bundleIdentifier` are read from `app.json` when the run is published. A project configured only through `app.config.ts` sets `expo.scheme`. Named HTTPS hosts are not trusted inside the simulator, so point `EXPO_PUBLIC_*` URLs at the LAN IP or `loopbackUrls`.

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

Failure degrades to `http://localhost:<port>` and never blocks the dev run. Named hosts stay off on Windows, in CI (`CI=1` / `CI=true`, `GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`), when `BUNCARGO_HOSTS=0` or `BUCARGO_SKIP_MKCERT=true`, or with `--no-hosts`.

Set `BUCARGO_SKIP_MKCERT=true` in cloud workspace secrets/environment to skip automatic local HTTPS setup, including the mkcert prompt. Local URLs use `http://localhost:<port>`; Tailscale sharing still works.

### Loopback URLs

Some clients cannot follow a named HTTPS URL: Playwright does not trust the local CA, the Stripe CLI fails the HTTP→HTTPS redirect, and GUI database clients want a plain connection string. Enabling `hosts` rewrites `urls.<name>` in place, so those consumers get `loopbackUrls` instead - the same set of services and apps, always addressed as `http://localhost:<port>`.

It is available everywhere the URLs are: `env.loopbackUrls`, the `env()` and `envVars()` context, `HookContext`, the `<NAME>_LOOPBACK_URL` env var, and `buncargo env --get loopbackUrls.api` for shell scripts. There is no `<app>Local` member - that key is the LAN IP, a different address for a different purpose (mobile devices on the network).

```typescript
// playwright.config.ts
const env = JSON.parse(execSync("bunx buncargo env").toString());
export default defineConfig({ use: { baseURL: env.loopbackUrls.web } });
```

## Private remote services

Install and sign in to Tailscale on your computer and server, then run `bunx buncargo dev` on the server. BuncargoBar automatically discovers reachable Buncargo environments in your tailnet and groups them by project, with branch/worktree and machine names.

For Cursor and other Linux cloud sandboxes, store a **reusable, ephemeral, tagged** Tailscale enrollment key as the runtime secret `TS_AUTHKEY`. Starting `buncargo dev` automatically downloads verified Tailscale binaries and signs in using userspace networking when no connected Tailscale installation is available. No root access, TUN device, systemd, browser login or per-agent secret is required. Each sandbox gets an independent identity; multiple worktrees on one machine share its coordinator. Never bake authenticated state into a sandbox image.

All selected apps and services with host ports are shared. Workers, jobs and portless services are skipped. `expose` only controls the separate public Cloudflare tunnels. Browser apps open private HTTPS URLs directly; Postgres and Redis use the Tailscale hostname and port in your database client; the menu bar's TablePlus button opens the connection with the dev credentials filled in. Custom services default to TCP; use `exposeProtocol: "http"` for custom web services.

```sh
bunx buncargo dev
bunx buncargo tailnet status
bunx buncargo tailnet status --json
```

Publishers require Tailscale **1.102.3 or later**, MagicDNS and HTTPS enabled, and permission to configure Serve. Tailnet access rules must allow your computer to reach discovery port **48443** and service ports **20000–29999** on the publishers. Installing Tailscale alone does not sign it in. Without Tailscale or `TS_AUTHKEY`, development remains local; one-shot commands do not enroll a sandbox.

Use same-origin frontend API paths through your development server's proxy where possible. Absolute sandbox-local URLs embedded in JavaScript are still local to the browser's computer. Buncargo does not rewrite application bundles or application-specific authentication settings. SSE and WebSockets stream through Tailscale Serve. Direct versus relayed performance depends on the actual network route.

See [Tailscale setup, lifecycle and verification](docs/tailscale.md).

**Cookies ignore ports:** apps sharing the machine hostname must namespace their development cookies. Buncargo supplies `BUNCARGO_WORKSPACE_ID` and, for Expo apps, `EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID`. Use the cookie helper in your auth configuration; install Buncargo as a runtime dependency in apps that import it. The backend helper preserves production and E2E cookie names, while the client helper uses Expo’s `__DEV__` flag. Missing workspace IDs retain the original names. This prevents accidental session collisions between trusted dev apps, not cross-app security isolation.

Backend:

```ts
import { devCookiePrefix } from "buncargo/runtime";

const advanced = {
	cookiePrefix: devCookiePrefix("platform"),
};
```

Expo:

```ts
import { devCookiePrefix } from "buncargo/client";

const workspaceId = process.env.EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID;
const options = {
	cookiePrefix: devCookiePrefix("platform", workspaceId),
};
```

Expo requires the literal public environment-variable read in application code: Metro does not inline those reads inside dependencies. Other browser clients pass their development flag explicitly as the third argument; the client helper otherwise leaves the prefix unchanged when `__DEV__` is unavailable. The client entry has no Node or Bun imports.

Update both the CLI and menu bar to use Tailscale discovery.

## Run registry and the menu bar app

Every `buncargo dev` publishes itself to `~/.buncargo/runs.json`: project,
worktree, branch, pid, and each app and service with its URL, public tunnel and
state. It is written when the run starts, patched as servers become ready, and
removed on teardown. Readers filter dead owners without rewriting files; writers prune obsolete entries. Each new invocation has a session identity, so different app subsets in one checkout remain visible.

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
bunx buncargo stop --all      # checkout sessions; retains containers another live session needs
bunx buncargo stop api --run=<session-id>  # select an exact run
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
Only running checkouts appear. **Open** launches the primary app and the phone
button opens an Expo app in that checkout's simulator; the chevron opens a panel
with every app and service, each with open, copy, a TablePlus button for
databases, a simulator button for Expo apps, and a stop button. **Stop run**
stops everything.

It is a reader: it never signals a process, talks to Docker or drives `simctl`;
it shells out to `buncargo stop` and `buncargo sim` using the exact interpreter
that started the run, so a worktree on a different buncargo version acts with
its own build. See [`menubar/README.md`](menubar/README.md).

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

### Dotenv input

Use `options.envFiles` to load root-relative dotenv defaults for dev, Prisma, exec
and programmatic environments:

```ts
options: {
  envFiles: [".env.defaults", { path: ".env.local", optional: true }],
},
env: (_ports, urls, ctx) => ({
  JOBS_DATABASE_URL: urls.postgres,
  TOKEN: ctx.env?.TOKEN,
}),
```

Paths resolve from the discovered repository root, even when invoked in a nested
workspace. String entries are required files. `optional: true` permits a missing
file but does not hide read/permission errors. Later files override earlier ones.
Dotenv quoting and multiline values are supported; shell expressions and
`${OTHER_VARIABLE}` references are not expanded.

Environment precedence, lowest to highest:

1. Explicit dotenv files, in order.
2. Inherited process environment.
3. Generated local values and service static values, then shared `config.env`.
4. App static values, generated server `PORT`/`HOST`, then app `envVars`.
5. Explicit programmatic exec `options.env`, if supplied.

A stale dotenv `DATABASE_URL` cannot override the allocated local URL. Deliberate
configuration and app overrides remain authoritative. Use the shared callback for
project-specific aliases and `ctx.env` for resolved inputs.

Inputs load **after config evaluation**. Top-level config imports cannot depend on
files declared by that config. Each environment holds an input snapshot; create or
load a new environment to reread the files. Loading does not mutate `process.env`,
leak inputs between projects or rewrite credentials. `options.envFile` is the
independent, opt-in [output synchronization](#dotenv-sync) setting. Without
`envFiles`, child processes still inherit their parent environment.

Use `loopbackUrls` for host-side scripts, LAN/device URLs for device access, and
`ctx.publicUrls` for explicitly enabled tunnels. Docker containers use Compose
service DNS names and container ports to communicate. Host gateway names such as
`host.docker.internal` are not guaranteed across runtimes. Keep internal database
credentials out of browser and Expo public environment mappings.

### Injected

| Variable | Where | Meaning |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | Compose / shared env | Isolated project name |
| `NODE_ENV` | Shared env | `development` unless production build |
| `<NAME>_PORT` | Shared env | Assigned port for each port-bearing service/app |
| `<NAME>_URL` | Shared env | Local URL. Named HTTPS when hosts are active (`https://api.myapp.localhost`) |
| `<NAME>_LOOPBACK_URL` | Shared env | Always `http://localhost:<port>`, never rewritten by named hosts |
| `<NAME>_PUBLIC_URL` | Shared env | Tunnel URL while a tunnel is active |
| `NODE_EXTRA_CA_CERTS` | Shared env | Path to the mkcert CA when named hosts are active |
| `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` | Shared env | `.localhost` (or `.<tld>`) so Vite accepts the named Host |
| `DATABASE_URL` | Shared env | From `service.postgres()` |
| `REDIS_URL` | Shared env | From `service.redis()` |
| `CLICKHOUSE_URL` | Shared env | From `service.clickhouse()` |
| `CLICKHOUSE_NATIVE_PORT` | Shared env | ClickHouse `secondaryPort` |
| `PORT` | Server app process | That server app's assigned port; not generated for workers |
| `HOST` | Server app process | `0.0.0.0`; not generated for workers |
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

It sets `server.port` from `PORT`, binds `server.host` to `127.0.0.1` (Vite's default `localhost` resolves to `[::1]` on many systems, so anything dialing IPv4 gets a refused connection), and passes the named-hosts suffix through to `server.allowedHosts`. Before Vite initializes its host checks, the plugin also allows the authenticated local node's exact hostname. If a cloud node finishes signing in later, the plugin watches Buncargo's coordinator state and restarts Vite once to reload its host configuration. No manual `allowedHosts` entry is needed. HMR stays origin-relative so its WebSocket follows whichever local or Tailscale URL loaded the page.

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

The configuration reference covers the main public options; `src/types/all-types.ts` is the complete type contract.

### `DevConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectPrefix` | `string` | required | Compose/project prefix. Must start with a letter and be lowercase/`0-9`/`-`. Example: `"gey"` |
| `services` | `Record<string, ServiceConfig>` | required | Container services; `{}` permits app-only configurations. |
| `apps` | `Record<string, AppConfig>` | `undefined` | Servers and portless workers to orchestrate |
| `env` | `(ports, urls, ctx) => Record<string, string \| number>` | `undefined` | Shared overlay merged onto computed ports/urls for every process |
| `hooks` | `DevHooks` | `undefined` | Lifecycle hooks |
| `migrations` | `MigrationConfig[]` | `[]` | Selected custom migrations, in order after automatic Prisma migrations for the selected database |
| `seed` | `SeedConfig` | `undefined` | After migrations, before servers |
| `prisma` | `PrismaConfig` | `undefined` | Enables `dev.prisma` and `buncargo prisma` |
| `options` | `DevOptions` | `undefined` | Isolation, watchdog, helper app names |
| `docker` | `DockerComposeGenerationOptions` | `undefined` | Generated compose path, volumes, Docker auto-start |

Top-level `envVars` is removed. Use the top-level `env` overlay for shared values (rewritten `WEB_URL`, `VITE_*`), and `apps.<name>.envVars` for app-only values.

### `ServiceConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `"service" \| "job"` | `"service"` | Long-running container or finite command |
| `rerun` | `"always"` | required for jobs | Explicitly allow execution on subsequent starts |
| `afterPreparation` | `boolean` | `false` | Start after migrations, generation, hooks and seed |
| `port` | `number` | omitted | Base host port; omit for an internal container or job |
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

`UrlBuilderContext`: `{ port, secondaryPort?, host, localIp }`. See [portless containers and finite jobs](#portless-containers-and-finite-jobs) for completion and rerun behavior.

### `AppConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `kind` | `"server" \| "worker"` | `"server"` | HTTP server or process without an endpoint |
| `port` | `number` | required for servers | Base host port; prohibited for workers |
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
| `expo` | `boolean \| { scheme?, simulator? }` | inferred | Expo dev server: gets `RCT_METRO_PORT` and a `buncargo sim` device. Inferred when `devCommand` mentions `expo` |

Use `kind: "worker"` for a long-running process without a listener. Workers require a command and reject port, HTTP-health, exposure and Expo options.

`envVars` context: `{ projectName, localIp, portOffset, publicUrls, loopbackUrls, env }`; `env` is the resolved input snapshot.

### `DevOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `worktreeIsolation` | `boolean` | `true` | Unique ports and compose project per worktree |
| `autoShutdown` | `number \| false` | `180000` via CLI | Idle watchdog timeout in **ms**. `false` disables (same as `--keep-containers`) |
| `envFiles` | `(string \| { path, optional? })[]` | `[]` | Root dotenv input defaults; later files win, generated local values stay authoritative |
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
| `writeStrategy` | `"always" \| "if-missing"` | `"always"` | Atomic write when content changes; `if-missing` rejects an existing file that differs from the model |
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
| `generateCheck` | `(ctx) => boolean \| Promise<boolean>` | always generate | Return `true` when generation is needed; your check must verify all inputs and outputs |

### `MigrationConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `requiredServices` | `readonly string[]` | any selected service | All listed services must be selected; `[]` permits app-only preparation |
| `name` | `string` | required | Display name |
| `command` | `string` | required | Shell command |
| `cwd` | `string` | repo root | Working directory |

### `SeedConfig`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `requiredServices` | `readonly string[]` | any selected service | All listed services must be selected; `[]` permits app-only preparation |
| `command` | `string` | required | Seeder command (`buncargo dev --seed` uses this) |
| `cwd` | `string` | repo root | Working directory |
| `check` | `(ctx) => Promise<boolean>` | always run | Return `true` to seed. `checkTable(table)` defaults its service to `prisma.service ?? "postgres"` |
| `forceExit` | `boolean` | `true` for `bun ./file.ts` commands | Exit the seed process after the module finishes, even if sockets/pools are still open |

### `DevHooks` and `HookContext`

| Hook | When |
| --- | --- |
| `beforeMigrations` | After selected database readiness, before automatic Prisma and custom migrations |
| `afterContainersReady` | After early containers, dotenv sync, migrations, and generation; before seeding |
| `beforeServers` | Before app processes start |
| `afterServers` | After health waits succeed |
| `beforeStop` | Before `stop()` |

`HookContext`: `{ projectName, ports, urls, publicUrls, exec, root, isCI, portOffset, localIp, signal, selectedApps, selectedServices }`. Migration and seed entries accept `requiredServices` to scope preparation; all listed services must be selected.

`exec(cmd, { app?, cwd?, verbose?, env?, throwOnError?, signal?, timeoutMs?, killGraceMs? })` accepts a shell command string or an argv array and returns `{ exitCode, stdout, stderr }`. See [checkout execution](#execute-with-the-checkout-environment).

### `StartOptions` / `StopOptions`

`start({ verbose, wait, startServers, productionBuild, skipSeed, skipEnvironmentLog, onlyApps, autoStartDocker, signal, prepare, onPhase })`

`stop({ verbose, removeVolumes, signal })`

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

Server app readiness uses `healthEndpoint` (HTTP). Set `healthEndpoint: false` for Metro/Expo. Workers are ready when spawned and alive; portless containers use runtime process state, and finite jobs require successful completion.

HTTP app health checks probe `http://localhost:<port>`, including when the app has a named HTTPS URL. This keeps readiness and reused-process detection independent of local certificate trust.

## Public tunnels

Mark targets with `expose: true`, then `bunx buncargo dev --expose` or `--expose=api,web`.

The `expose` config option is deprecated. It still controls these public tunnels; Tailscale sharing automatically includes all selected apps and services with a host port.

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
| `Worker "…" is already running` | Library startup encountered an owned worker | Reuse it through the CLI or use `dev --takeover` |
| `Apple container cannot verify finite job exit codes yet` | A job was selected with Apple | Use `--runtime=docker` |
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
| `ERR_CONTENT_DECODING_FAILED` on a named URL | Stale hostsd decoded gzip but kept `Content-Encoding` | `buncargo hosts install` to replace the daemon bundle |
| `Portless is serving :443` (or Caddy / nginx / Docker) | Another proxy owns HTTPS | Stop that process, or set `hosts: false` / `--no-hosts` |
| `ERR_SSL_PROTOCOL_ERROR` in the browser, `hosts status` healthy | Another server shares `:443` on `[::1]`, which browsers try first for `.localhost` | `buncargo hosts status` names it; stop it (`lsof -nP -iTCP:443`) or set `hosts: false` |

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

`createDevEnvironment(config)` constructs the same environment directly and infers from the supplied config. Construction reads persisted ports or computes a cold preview without runtime probes. Startup finalizes allocation and updates the ports/URLs objects in place; re-read them after startup instead of holding copied preview values.

Use `env.exec(["bun", "scripts/maintenance.ts"], { app: "api" })` to run a command without starting the lifecycle.

## License

MIT
