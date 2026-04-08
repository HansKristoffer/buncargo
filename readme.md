# Buncargo

A Bun-first development environment toolkit that eliminates the friction of local dev setup. Define your entire dev stack in a single typed config file—Docker services, app servers, environment variables, migrations, and more.

## Why Buncargo?

**The problem**: Local development environments are fragile. Teams maintain separate `docker-compose.yml` files, scatter port assignments across `.env` files, manually manage container lifecycles, and struggle with port conflicts when working on multiple branches.

**The solution**: Buncargo provides a single source of truth for your dev environment. One `dev.config.ts` file defines everything. Type-safe. Auto-generated Docker Compose. Worktree-aware port isolation. Zero configuration drift.

## Key Features

- **Single config file** — Define services, apps, ports, URLs, migrations, and hooks in one typed `dev.config.ts`
- **Auto-generated Docker Compose** — No manual compose files; buncargo generates them from your config
- **Worktree isolation** — Each git worktree gets unique ports and isolated containers automatically
- **Built-in service presets** — One-liner setup for Postgres, Redis, ClickHouse with health checks and URL templates
- **Custom service support** — Full Docker Compose escape hatch for any service
- **Dev server orchestration** — Start and monitor multiple app servers with health checks
- **Public tunnels** — Expose services via Cloudflare Quick Tunnels for webhook testing and mobile dev
- **Prisma integration** — Run Prisma commands with auto-injected `DATABASE_URL`
- **Lifecycle hooks** — Run migrations, seeders, or custom scripts at the right time
- **Programmatic API** — Access ports/URLs in tests or scripts
- **Watchdog auto-shutdown** — Containers stop automatically after inactivity

## Quick Start

### 1. Install

```bash
bun add -d buncargo
```

### 2. Create `dev.config.ts`

```typescript
import { defineDevConfig, service } from 'buncargo'

export default defineDevConfig({
  projectPrefix: 'myapp',

  services: {
    postgres: service.postgres({ database: 'mydb' }),
    redis: service.redis(),
  },

  apps: {
    api: {
      port: 3000,
      devCommand: 'bun run dev',
      cwd: 'apps/backend',
      requiredServices: ['postgres', 'redis'],
    },
    web: {
      port: 5173,
      devCommand: 'bun run dev',
      cwd: 'apps/frontend',
      requiredApps: ['api'],
    },
  },

  envVars: (ports, urls) => ({
    DATABASE_URL: urls.postgres,
    REDIS_URL: urls.redis,
    API_PORT: ports.api,
  }),
})
```

### 3. Add scripts to `package.json`

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

Buncargo will:
1. Generate a Docker Compose file from your config
2. Start the containers required by the selected apps and wait for health checks
3. Run any configured migrations
4. Start your dev servers
5. Print all ports and URLs

## CLI Commands

```bash
bunx buncargo dev              # Start containers + dev servers
bunx buncargo dev --up-only    # Start containers only (no dev servers)
bunx buncargo dev --down       # Stop containers
bunx buncargo dev --reset      # Stop containers and remove volumes
bunx buncargo dev --expose     # Start with public tunnels for expose:true targets
bunx buncargo dev --expose=api # Expose specific targets
bunx buncargo dev --migrate    # Run migrations only
bunx buncargo dev --seed       # Run migrations and seeders
bunx buncargo prisma <args>    # Run Prisma CLI with correct DATABASE_URL
bunx buncargo typecheck        # Run TypeScript typecheck across workspaces
bunx buncargo env              # Print ports/URLs as JSON
bunx buncargo help             # Show help
bunx buncargo version          # Show version
```

## Services

### Built-in Presets

Use `service.*` helpers for common databases with sensible defaults:

```typescript
services: {
  postgres: service.postgres({ database: 'mydb' }),
  redis: service.redis(),
  clickhouse: service.clickhouse({ database: 'analytics' }),
}
```

Each preset includes:
- Default Docker image
- Health check configuration
- URL template (e.g., `postgresql://postgres:postgres@localhost:5432/mydb`)
- Volume for data persistence

### Custom Services

Use `service.custom()` for any Docker service:

```typescript
services: {
  rabbitmq: service.custom({
    port: 5672,
    healthCheck: false,
    docker: {
      image: 'rabbitmq:3-management-alpine',
      ports: ['${RABBITMQ_PORT:-5672}:5672', '15672:15672'],
      environment: {
        RABBITMQ_DEFAULT_USER: 'guest',
        RABBITMQ_DEFAULT_PASS: 'guest',
      },
    },
  }),
  nats: service.custom({
    port: 4222,
    docker: {
      image: 'nats:2-alpine',
      ports: ['${NATS_PORT:-4222}:4222'],
    },
  }),
}
```

## Apps

Define dev servers to run alongside containers:

```typescript
apps: {
  api: {
    port: 3000,
    devCommand: 'bun run dev',
    cwd: 'apps/backend',
    healthEndpoint: '/health',
    requiredServices: ['postgres', 'redis'],
  },
  web: {
    port: 5173,
    devCommand: 'bun run dev',
    cwd: 'apps/frontend',
    healthEndpoint: '/',
    requiredApps: ['api'],
  },
}
```

Use `requiredServices` to declare which Docker services an app needs, and `requiredApps` to declare app-to-app dependencies. Both are typed from the configured keys in `defineDevConfig()`.

`onlyApps` on `start()` or `startServers()` launches the named apps plus any transitive `requiredApps`.

`requiredServices` is strict: if the selected app closure resolves to no services, startup fails with an actionable error instead of falling back to all services.

## Environment Variables

The `envVars` function builds all env vars from computed ports and URLs:

```typescript
envVars: (ports, urls, { localIp, publicUrls }) => ({
  DATABASE_URL: urls.postgres,
  REDIS_URL: urls.redis,
  API_PORT: ports.api,
  EXPO_API_URL: `http://${localIp}:${ports.api}`,
  WEBHOOK_URL: publicUrls.api ?? urls.api,
})
```

`buildEnvVars()` always includes, for each service/app name `foo`:

- `FOO_PORT` — assigned port
- `FOO_URL` — local URL (LAN)
- `FOO_PUBLIC_URL` — only while a public tunnel is active for that name

Your `envVars` callback receives `publicUrls` and typically maps client bundles, e.g. `EXPO_PUBLIC_API_URL: publicUrls.api ?? urls.api`.

These are injected into:
- Docker Compose services
- Dev server processes
- Hook `exec()` calls
- Prisma commands

## Worktree Isolation

When working in git worktrees, buncargo automatically assigns unique port offsets (10-99) so each worktree has isolated:
- Ports (e.g., postgres on 5442 instead of 5432)
- Docker Compose project names
- Containers, networks, and volumes

This means you can run multiple branches simultaneously without conflicts.

To disable isolation and share state across worktrees:

```typescript
options: {
  worktreeIsolation: false
}
```

## Public Tunnels

Expose local services to the internet using Cloudflare Quick Tunnels:

```typescript
services: {
  postgres: service.postgres({ database: 'mydb' }),
},
apps: {
  api: {
    port: 3000,
    devCommand: 'bun run dev',
    expose: true,  // Mark as exposable
    requiredServices: ['postgres'],
  },
}
```

```bash
bun run dev --expose      # Expose all targets with expose: true
bun run dev --expose=api  # Expose specific targets
```

Public URLs are printed in the console and available via `publicUrls` in `envVars`:

```typescript
envVars: (_ports, urls, { publicUrls }) => ({
  WEBHOOK_URL: publicUrls.api ?? urls.api,
})
```

**CLI vs programmatic ordering:** `bunx buncargo dev --expose` starts Cloudflare quick tunnels after containers and migrations but **before** the interactive dev-server command (e.g. `concurrently`) runs. Until those servers are listening on their ports, tunnel traffic can briefly error. For “servers first, then public URLs,” use the API: e.g. `await dev.startServers({ onlyApps: ['api', 'platform'] })`, then `await dev.openPublicTunnels({ waitForHealthy: ['api', 'platform'] })` (optional; waits HTTP health first), then read `dev.buildEnvVars()` for spawned children.

**Expo hybrid:** buncargo is suited to exposing **API** and **platform** (Vite, etc.) for devices on cellular. **Metro** often uses Expo’s own tunnel (`expo start --tunnel`); you usually do **not** add Metro as a buncargo `app` unless you want buncargo to start it. Wire `EXPO_PUBLIC_*` from `publicUrls.* ?? urls.*` in `envVars`.

**Programmatic helper:** `openPublicTunnels({ names?, waitForHealthy? })` applies tunnel URLs via `setPublicUrls` and returns `close()` to stop tunnels and clear public URLs. Call `buildEnvVars()` after `openPublicTunnels` resolves so `envVars` and `*_PUBLIC_URL` see the tunnel origins.

## Lifecycle Hooks

Run code at specific points in the startup/shutdown cycle:

```typescript
hooks: {
  afterContainersReady: async (ctx) => {
    await ctx.exec('bunx prisma migrate deploy', { cwd: 'packages/prisma' })
  },
  beforeServers: async (ctx) => {
    await ctx.exec('bun run seed')
  },
  afterServers: async (ctx) => {
    console.log(`API running at ${ctx.urls.api}`)
  },
  beforeStop: async (ctx) => {
    await ctx.exec('bun run cleanup', { throwOnError: false })
  },
}
```

Hook context provides:

```typescript
interface HookContext {
  projectName: string
  ports: { postgres: number, api: number, ... }
  urls: { postgres: string, api: string, ... }
  publicUrls: { api?: string, ... }
  root: string
  isCI: boolean
  portOffset: number
  localIp: string
  exec(cmd: string, opts?): Promise<ExecResult>
}
```

## Migrations and Seeding

### Migrations

Run migration commands after containers are healthy:

```typescript
migrations: [
  { name: 'prisma', command: 'bunx prisma migrate deploy', cwd: 'packages/prisma' },
  { name: 'clickhouse', command: 'bun run migrate:clickhouse' },
]
```

### Seeding

Seed the database with a check to avoid re-seeding:

```typescript
seed: {
  command: 'bun run seed',
  check: ({ checkTable }) => checkTable('User', 'postgres'),
}
```

## Prisma Integration

Configure Prisma to use the correct database URL:

```typescript
prisma: {
  cwd: 'packages/prisma',
  service: 'postgres',        // Service key from `services` (default: 'postgres')
  urlEnvVar: 'DATABASE_URL',  // Default: 'DATABASE_URL'
}
```

Then run Prisma commands through buncargo:

```bash
bun run prisma migrate dev
bun run prisma studio
bun run prisma db push
```

Buncargo ensures the database container is running and injects the correct `DATABASE_URL` with worktree-aware ports.

## Programmatic API

Access the dev environment from code (useful for tests):

```typescript
import { loadDevEnv } from 'buncargo'

const env = await loadDevEnv()

console.log(env.ports.postgres)  // 5432 (or offset port)
console.log(env.urls.api)        // http://localhost:3000
console.log(env.urls.postgres)   // postgresql://postgres:postgres@localhost:5432/mydb

// Start/stop programmatically
await env.start()
await env.stop({ removeVolumes: true })

// Build env vars for subprocess
const envVars = env.buildEnvVars()
```

## Docker Compose Generation

Buncargo generates Docker Compose from your config. No external `docker-compose.yml` is read.

```typescript
docker: {
  generatedFile: '.buncargo/docker-compose.generated.yml',
  writeStrategy: 'always',  // or 'if-missing'
  volumes: {
    shared_cache: {},
  },
}
```

## Health Checks

Built-in health check types:

| Type | Description |
|------|-------------|
| `pg_isready` | PostgreSQL readiness check |
| `redis-cli` | Redis PING check |
| `http` | HTTP endpoint check |
| `tcp` | TCP port check |

Or provide a custom health check function:

```typescript
healthCheck: async (port) => {
  const res = await fetch(`http://localhost:${port}/health`)
  return res.ok
}
```

## Watchdog Auto-Shutdown

When running via CLI, containers automatically stop after 10 minutes of inactivity. The watchdog monitors heartbeats and shuts down orphaned environments.

## Full Example

```typescript
import { defineDevConfig, service } from 'buncargo'

export default defineDevConfig({
  projectPrefix: 'platform',

  services: {
    postgres: service.postgres({ database: 'platform' }),
    redis: service.redis(),
    clickhouse: service.clickhouse({ database: 'platform' }),
  },

  apps: {
    api: {
      port: 3000,
      expose: true,
      devCommand: 'bun run dev',
      cwd: 'apps/backend',
      healthEndpoint: '/health',
      requiredServices: ['postgres', 'redis', 'clickhouse'],
    },
    web: {
      port: 5173,
      devCommand: 'bun run dev',
      cwd: 'apps/frontend',
      requiredApps: ['api'],
    },
  },

  envVars: (ports, urls, { localIp, publicUrls }) => ({
    DATABASE_URL: urls.postgres,
    REDIS_URL: urls.redis,
    CLICKHOUSE_URL: urls.clickhouse,
    API_URL: urls.api,
    VITE_API_URL: urls.api,
    EXPO_API_URL: `http://${localIp}:${ports.api}`,
    WEBHOOK_URL: publicUrls.api ?? urls.api,
  }),

  migrations: [
    { name: 'prisma', command: 'bunx prisma migrate deploy', cwd: 'packages/prisma' },
  ],

  seed: {
    command: 'bun run seed',
    check: ({ checkTable }) => checkTable('User', 'postgres'),
  },

  prisma: {
    cwd: 'packages/prisma',
  },

  hooks: {
    afterContainersReady: async (ctx) => {
      console.log(`Containers ready on port offset ${ctx.portOffset}`)
    },
  },
})
```

## License

MIT
