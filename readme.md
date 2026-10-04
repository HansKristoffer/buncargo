# Buncargo

A Bun-first development environment toolkit. Define Docker services, app servers, ports, env, migrations, and tunnels in one typed `dev.config.ts`.

![BuncargoBar showing a running project, its apps and services](https://raw.githubusercontent.com/HansKristoffer/buncargo/main/buncargo-topbar.png)

*[BuncargoBar](menubar/README.md), the optional menu bar app: every running project, worktree, app and service - open a URL, copy a connection string, or stop one of them.*

## Why Buncargo?

Local development environments are fragile: hand-written compose files, scattered ports, and conflicts when two checkouts run at once. Buncargo is the single source of truth. It generates Compose, allocates a unique port block per project (and per worktree), starts only the services the selected apps need, and tears containers down when the CLI is gone.

## Key Features

- **Single config file** - services, apps, ports, URLs, migrations, hooks
- **Auto-generated Docker Compose** - stamped with `buncargo.*` labels
- **Port allocation** - hash of `projectPrefix` + worktree, then probe and persist `.buncargo/ports.json`
- **Built-in presets** - Postgres, Redis, ClickHouse
- **Dev server orchestration** - reuse healthy apps, kill own orphans, fail on foreign port owners
- **Terminal UI** - `--tui`: every app in its own terminal pane, full-screen apps (Shopify CLI, Expo) render natively, an Overview interleaves the rest
- **Non-essential apps and logs** - `essential: false` apps stop without ending the run (`r` restarts); every run's output in `.buncargo/logs`, read with `buncargo logs`
- **Phased public tunnels** - start backend, wait for health, open tunnels, then start apps that need `*_PUBLIC_URL`
- **Prisma integration** - `bunx buncargo prisma` with the right `DATABASE_URL`
- **Named HTTPS URLs** - opt-in `https://api.myapp.localhost` via a shared loopback proxy (mkcert + `:443`)
- **Watchdog** - one sweeper per machine removes containers once their run has ended, their checkout is deleted, or they are left stopped
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

Add `integrations: [expo()]` (from `buncargo/expo`): every app whose `devCommand` runs `expo` then gets `RCT_METRO_PORT`, so each worktree's Metro listens on its own port instead of asking for 8081. See [Expo and the iOS simulator](#expo-and-the-ios-simulator).

```json
{
	"scripts": {
		"dev:with-api": "bunx buncargo dev --apps=expoApp",
		"dev:expose": "bunx buncargo dev --apps=expoApp,platform --expose"
	}
}
```

`buncargo dev --apps=expoApp -- --clear` appends `--clear` to the attached Expo command.

### Shopify app

```typescript
import { defineDevConfig, service } from "buncargo";
import { shopify } from "buncargo/shopify";

export default defineDevConfig({
	projectPrefix: "sebprint",
	services: { postgres: service.postgres(), redis: service.redis() },
	apps: {
		api: { port: 3000, cwd: "apps/backend", devCommand: "bun run dev", requiredServices: ["postgres", "redis"], healthEndpoint: "/health" },
		platform: { port: 5173, cwd: "apps/platform", devCommand: "bun run dev", requiredApps: ["api"] },
	},
	integrations: [shopify({ config: "shopify.app.toml", frontend: "platform", backend: "api" })],
	profiles: { default: { apps: ["shopify"] } },
});
```

```toml
# shopify.app.toml: buncargo owns every process; the CLI gets one web that starts nothing.
web_directories = [".buncargo/shopify/web"]
```

`shopify()` adds a `shopify` app running `shopify app dev --config …`, started only once `platform`, `api` and every extension watcher are up. It adds a watcher per extension workspace (`apps/extension-*`, `extensions/*` with a `dev` script), each built once with its `build` script before the watcher starts. It adds `SHOPIFY_APP_URL` (the captured tunnel URL, through the capture's `env`), `SHOPIFY_API_KEY` (`client_id` from the toml), `SHOPIFY_APP_CONFIG` and `SHOPIFY_DEV_STORE` for every process, and an exclusive lease on the dev app, so two worktrees cannot both rewrite its URL. The `web_directories` line matters: when it is empty, Shopify CLI starts every `shopify.web.toml` it finds, a second API and a second Vite beside buncargo's. The generated web has the frontend's port and a `dev` command that only waits for it (`buncargo wait --app=platform --hold`), so the tunnel reaches buncargo's Vite through the CLI's proxy, and Vite's `/api` proxy (`buncargoVite({ proxy: { "/api": "api" } })`) reaches the API. Webhooks, the app proxy and customer-account extension calls all arrive through that one URL. `bunx buncargo setup` patches the toml, and checks the login, the link and version agreement between the tomls.

The `shopify` app is not essential: an extension build error or a lost session stops it, not the API and the frontend; fix it and press `r` in the TUI (`bunx buncargo dev --tui`, where the CLI's own interface runs in its pane) or run `bunx buncargo restart shopify`. Before anything starts, a preflight renews an expired CLI session with the terminal, so a login never fails half-way through a run. `p` and `g` open the preview and GraphiQL from the TUI footer. `bunx buncargo shopify link --config=local` links a toml to a dev app without letting the CLI rewrite it: only `client_id` and `name` come from the linked app, everything else from `shopify.app.toml`, and the toml's `dev_store_url` is kept.

The app, preview and GraphiQL URLs are labelled captures and the admin and dev store links are the integration's `describe` rows, so `bunx buncargo url` lists them all and `bunx buncargo open "shopify admin"` or `open previewUrl` opens one. `bunx buncargo shopify env` prints the app toml. An app that reads `SHOPIFY_APP_URL` at startup sets `restartOn: ["captured.appUrl"]`. A generated file can carry the URL into an extension (see [captures](#captured-output-and-generated-files)). [`example/shopify-plugin`](example/shopify-plugin) is a runnable version, booted end to end in CI with a fake `shopify` binary.

### Supabase

```typescript
import { defineDevConfig } from "buncargo";
import { supabase } from "buncargo/supabase";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {},
	apps: {
		web: { port: 5173, devCommand: "bun run dev", requiredServices: ["supabase"] },
	},
	integrations: [supabase({ publicEnvPrefix: "VITE_", types: { output: "src/database.types.ts" } })],
});
```

The Supabase CLI keeps running the local stack (`bun add -d supabase`, then `supabase init`); buncargo gives each checkout its own copy. The stack runs under the checkout's project name and ports through the CLI's `SUPABASE_*` overrides, so two worktrees no longer share one database and `supabase/config.toml` is never rewritten. `supabase` (the API), `supabaseDb` and, when enabled in the toml, `supabaseStudio` and `supabaseMail` are services: requiring any of them starts the whole stack, and they get ports, URLs, named hosts and the TablePlus link like any other service. Every process gets `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY` and `SUPABASE_DB_URL`, plus prefixed browser copies of the first three. Auth's `site_url` points at the primary app (`siteUrlApp` to choose) and its redirect list gains every app's URLs.

Each start runs `supabase migration up`, so a pull with new migrations needs nothing else; `types` regenerates the TypeScript types when the migrations change. `functions: true` adds `supabase functions serve` as a worker, and `exclude` skips containers (`["studio", "imgproxy"]`; CI skips Studio and analytics by default). `buncargo exec -- supabase db diff` runs the CLI against this checkout's stack. A run's stack is held for the idle timeout after it exits, like containers; `dev --down` stops it, and `dev --reset` deletes its data. Settings the stack started with, such as the redirect list, change with the next start after `dev --down`.

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

## Documentation

- [CLI, configuration and programmatic API reference](docs/reference.md)
- [Integrations](docs/integrations.md), including Expo, Shopify and Supabase
- [Remote sharing and relay operation](docs/frp.md)
- [BuncargoBar](menubar/README.md)
- [Container lifecycle and cleanup](docs/runtime-maintenance.md)
- [Release and recovery instructions](docs/releasing.md)

Requires Bun 1.4.2+ on macOS or Linux (Windows through WSL). Docker Compose is needed for Docker services; Apple container is an optional backend on supported Macs. App-only configurations can run without a container runtime.

## Upgrading

[`docs/migration.md`](docs/migration.md) lists what changed in each major version and what to do about it. Config validation names the replacement for each renamed field.

## License

MIT

## Development and releasing

Run `bun install --frozen-lockfile`, `bun run lint`, `bun test`, `bun run build`, and `bun run verify:package`. Startup benchmarks are reproducible CI regression checks; their generated reports stay in ignored `.buncargo/` and CI artifacts.

Squash PRs with conventional titles. Release Please proposes versions and changelogs; merge the release PR when ready to deploy the relay and publish the CLI and/or BuncargoBar. See [releasing](docs/releasing.md).
