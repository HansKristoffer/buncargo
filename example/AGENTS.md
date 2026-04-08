# Buncargo Config Guide (Docker + Seed + Maintenance)

Use the root `readme.md` as the canonical product guide. This file only keeps example-focused conventions and reminders that matter while working inside this repo's `example/` workspace.

## Standalone Setup (from scratch)

Use this section if you are starting in a project with no existing buncargo setup.

### 1) Install buncargo

```bash
bun add -d buncargo
```

### 2) Create config file in repo root

Create one of these files in the project root:

- `dev.config.ts` (recommended)
- `dev.config.js`
- `dev-tools.config.ts` (legacy alias)
- `dev-tools.config.js` (legacy alias)

Use `dev.config.ts` unless you have a reason to choose another name.

### 3) Add package scripts

```json
{
  "scripts": {
    "dev": "bunx buncargo dev",
    "dev:up": "bunx buncargo dev --up-only",
    "dev:down": "bunx buncargo dev --down",
    "dev:reset": "bunx buncargo dev --reset",
    "dev:env": "bunx buncargo env",
    "dev:expose": "bunx buncargo dev --expose",
    "prisma": "bunx buncargo prisma"
  }
}
```

### 4) Create your first `dev.config.ts`

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {
		postgres: service.postgres({ database: "myapp" }),
	},
	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
	}),
});
```

### 5) Start and verify

```bash
bun run dev
```

Expected results:

- Containers start from generated compose.
- Services are reachable on computed ports.
- Generated compose file appears at `.buncargo/docker-compose.generated.yml` (default path).

## Core Rules

- Define everything in `dev.config.ts`.
- Do not maintain a manual root `docker-compose.yml`.
- Use `service.*` helpers for built-in services whenever possible.
- Use `service.custom(...)` for non-built-in services.

## Minimal Config Template

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {
		postgres: service.postgres({ database: "myapp" }),
	},
	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
	}),
});
```

## Service Setup

### Built-in typed services

Use these first:

- `service.postgres(...)`
- `service.redis(...)`
- `service.clickhouse(...)`

Example:

```ts
services: {
	postgres: service.postgres({ database: "geysier" }),
	redis: service.redis(),
	clickhouse: service.clickhouse({ database: "geysier" }),
}
```

### Custom service

Use this for anything else:

```ts
services: {
	nats: service.custom({
		port: 4222,
		healthCheck: false,
		docker: {
			image: "nats:2-alpine",
			ports: ["${NATS_PORT:-4222}:4222"],
		},
	}),
}
```

## Docker Generation

`buncargo` generates compose from config and runs Docker with the generated file.

Optional docker block:

```ts
docker: {
	generatedFile: ".buncargo/docker-compose.generated.yml",
	writeStrategy: "always", // or "if-missing"
	volumes: {
		shared_cache: {},
	},
}
```

### What gets generated automatically

- Service images for built-ins
- Port mappings from computed `*_PORT` variables
- Built-in health checks
- Volumes (`postgres_data`, `clickhouse_data`, etc.)
- Environment fields for built-ins (`POSTGRES_DB`, `CLICKHOUSE_DB`, etc.)

## Apps and Environment Variables

Define app processes and all env vars in one place:

```ts
apps: {
	api: {
		port: 3000,
		devCommand: "bun run dev",
		cwd: "apps/backend",
		healthEndpoint: "/health",
	},
	platform: {
		port: 5173,
		devCommand: "bun run dev",
		cwd: "apps/platform",
		healthEndpoint: "/",
	},
},
envVars: (ports, urls, { localIp }) => ({
	DATABASE_URL: urls.postgres,
	VITE_API_URL: urls.api,
	CLICKHOUSE_NATIVE_PORT: ports.clickhouseSecondary,
	EXPO_PUBLIC_API_URL: `http://${localIp}:${ports.api}`,
}),
```

## Migrations, Seed, Prisma

### Migrations

```ts
migrations: [
	{ name: "prisma", command: "bunx prisma migrate deploy", cwd: "packages/prisma" },
	{ name: "clickhouse", command: "bun apps/backend/src/lib/clickhouse/run-ch-migrate.ts" },
],
```

### Seed

```ts
seed: {
	command: "bun run run:seeder",
	check: ({ checkTable }) => checkTable("User", "postgres"),
},
```

### Prisma integration

```ts
prisma: {
	cwd: "packages/prisma",
	// optional:
	// service: "postgres",
	// urlEnvVar: "DATABASE_URL",
},
```

## Prisma Setup (detailed)

Buncargo provides a built-in Prisma integration that ensures the database is running before any Prisma command executes. This eliminates the need for manual container management when working with migrations.

### Configuration

Add the `prisma` block to your `dev.config.ts`:

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {
		postgres: service.postgres({ database: "myapp" }),
	},
	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
	}),
	prisma: {
		cwd: "packages/prisma",       // Path to your Prisma schema directory
		service: "postgres",          // Which service key to start (default: "postgres")
		urlEnvVar: "DATABASE_URL",    // Env var for connection URL (default: "DATABASE_URL")
	},
});
```

### Options

| Option      | Type   | Default          | Description                                          |
|-------------|--------|------------------|------------------------------------------------------|
| `cwd`       | string | `"packages/prisma"` | Working directory containing `prisma/schema.prisma` |
| `service`   | string | `"postgres"`     | The service key from `services` to start             |
| `urlEnvVar` | string | `"DATABASE_URL"` | Environment variable name for database URL           |

### CLI Usage

After configuring, add a script to `package.json`:

```json
{
  "scripts": {
    "prisma": "bunx buncargo prisma"
  }
}
```

Run Prisma commands through buncargo:

```bash
# Create a new migration
bun run prisma migrate dev

# Apply pending migrations
bun run prisma migrate deploy

# Push schema changes without migration
bun run prisma db push

# Open Prisma Studio
bun run prisma studio

# Reset the database
bun run prisma migrate reset

# Generate Prisma Client
bun run prisma generate
```

### What Happens

When you run `bun run prisma <command>`:

1. Buncargo checks if the target database container is running.
2. If not running, it starts the container using the generated compose file.
3. It waits for the database to become healthy (using `pg_isready` for postgres).
4. It injects the correct `DATABASE_URL` (with worktree-aware port) into the environment.
5. It executes `bunx prisma <command>` in the configured `cwd`.

### Worktree-Aware Ports

Buncargo assigns unique ports per git worktree, so multiple feature branches can run simultaneously without port conflicts. The Prisma integration automatically uses the correct port for the current worktree.

Example output:

```
🔧 Prisma CLI
   Project: myapp-feature-xyz
   Database: localhost:5433
   (port offset +1)

✓ postgres already running
🔄 Running: prisma migrate dev
```

### Monorepo Example

For monorepos with Prisma in a shared package:

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "platform",
	services: {
		postgres: service.postgres({ database: "platform" }),
		redis: service.redis(),
	},
	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
		REDIS_URL: urls.redis,
	}),
	migrations: [
		{
			name: "prisma",
			command: "bunx prisma migrate deploy",
			cwd: "packages/prisma",
		},
	],
	prisma: {
		cwd: "packages/prisma",
	},
});
```

### Using with Multiple Databases

If your project uses multiple database services:

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "multi",
	services: {
		postgres: service.postgres({ database: "main" }),
		analytics: service.postgres({ database: "analytics" }),
	},
	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
		ANALYTICS_DATABASE_URL: urls.analytics,
	}),
	prisma: {
		cwd: "packages/db-main",
		service: "postgres",
		urlEnvVar: "DATABASE_URL",
	},
});
```

For the analytics database, create a separate script:

```json
{
  "scripts": {
    "prisma": "bunx buncargo prisma",
    "prisma:analytics": "DATABASE_URL=$ANALYTICS_DATABASE_URL bunx prisma --schema=packages/db-analytics/prisma/schema.prisma"
  }
}
```

### Programmatic Usage

When using `createDevEnvironment()` programmatically:

```ts
import { createDevEnvironment } from "buncargo";
import config from "./dev.config";

const dev = await createDevEnvironment(config);

// Get the database URL
const url = dev.prisma.getDatabaseUrl();

// Ensure the database is running
await dev.prisma.ensureDatabase();

// Run a Prisma command
const exitCode = await dev.prisma.run(["migrate", "dev"]);
```

## Public Tunnels (expose)

Buncargo can expose local services and apps to the internet using Cloudflare Quick Tunnels. This is useful for:

- Webhook development (Stripe, GitHub, etc.)
- Mobile testing with real devices
- Sharing work-in-progress with teammates
- Testing OAuth callbacks

### Marking Targets for Exposure

Add `expose: true` to any service or app you want to make publicly accessible:

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {
		postgres: service.postgres({ database: "myapp" }),
		redis: service.redis({ expose: true }), // Can be exposed
	},
	apps: {
		api: {
			port: 3000,
			devCommand: "bun run dev",
			cwd: "apps/backend",
			expose: true, // Can be exposed
		},
		web: {
			port: 5173,
			devCommand: "bun run dev",
			cwd: "apps/web",
		},
	},
	envVars: (_ports, urls, { publicUrls }) => ({
		DATABASE_URL: urls.postgres,
		// Public URL is available when tunnel is active
		WEBHOOK_URL: publicUrls.api ?? urls.api,
	}),
});
```

### CLI Usage

```bash
# Expose all targets with expose: true
bun run dev --expose

# Expose specific targets by name
bun run dev --expose=api

# Expose multiple specific targets
bun run dev --expose=api,web
```

### How It Works

When you run `--expose`:

1. Buncargo starts the dev environment as usual.
2. For each target marked with `expose: true` (or specified in `--expose=<names>`), it spawns a Cloudflare Quick Tunnel.
3. The public URLs are injected into the environment and available via `publicUrls` in `envVars`.
4. Tunnels are automatically cleaned up when the dev environment stops.

### Using Public URLs in Config

The `publicUrls` object in `envVars` contains the public tunnel URLs when active:

```ts
envVars: (ports, urls, { publicUrls }) => ({
	// Local URL (always available)
	API_URL: urls.api,

	// Public URL (only available when tunnel is active)
	// Use nullish coalescing to fall back to local URL
	WEBHOOK_URL: publicUrls.api ?? urls.api,
	PUBLIC_API_URL: publicUrls.api ?? "",

	// For frontend apps that need to know the public URL
	VITE_PUBLIC_URL: publicUrls.web ?? urls.web,
}),
```

### TypeScript Support

The `publicUrls` object is typed based on which services/apps have `expose: true`:

```ts
// Only services/apps with expose: true appear in publicUrls
envVars: (_ports, _urls, { publicUrls }) => {
	// ✓ Valid - api has expose: true
	const apiUrl: string | undefined = publicUrls.api;

	// ✗ Type error - postgres doesn't have expose: true
	// const pgUrl = publicUrls.postgres;

	return { WEBHOOK_URL: apiUrl ?? "" };
},
```

### Example Output

```
🌐 Starting public tunnels...

📡 Tunnel: api
   Local:  http://localhost:3000
   Public: https://abc123.trycloudflare.com

📡 Tunnel: web
   Local:  http://localhost:5173
   Public: https://def456.trycloudflare.com

✓ All tunnels active
```

### Programmatic Usage

When using `createDevEnvironment()` programmatically:

```ts
import { createDevEnvironment } from "buncargo";
import config from "./dev.config";

const dev = await createDevEnvironment(config);

// Set public URLs manually (usually done by CLI)
dev.setPublicUrls({
	api: "https://abc123.trycloudflare.com",
});

// Build env vars with public URLs included
const envVars = dev.buildEnvVars();
console.log(envVars.WEBHOOK_URL); // https://abc123.trycloudflare.com

// Clear public URLs
dev.clearPublicUrls();
```

### Notes

- Tunnels require no authentication or account setup (uses Cloudflare Quick Tunnels).
- URLs change on each restart - they are temporary by design.
- Only HTTP/HTTPS services can be tunneled (not raw TCP like postgres).
- The `--expose` flag only works with `bun run dev`, not with `--up-only` or `--down`.

## Lifecycle Hooks (maintenance tasks)

Use hooks to keep maintenance logic close to config:

```ts
hooks: {
	afterContainersReady: async (ctx) => {
		await ctx.exec("bun run health:check");
	},
	beforeServers: async (ctx) => {
		await ctx.exec("bun run cache:warm");
	},
	beforeStop: async (ctx) => {
		await ctx.exec("bun run cleanup:temp", { throwOnError: false });
	},
},
```

## Full Platform Example

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "platform",

	services: {
		postgres: service.postgres({ database: "platform" }),
		redis: service.redis(),
		clickhouse: service.clickhouse({ database: "platform" }),
	},

	apps: {
		api: {
			port: 3000,
			expose: true,
			devCommand: "bun run dev",
			cwd: "apps/backend",
			healthEndpoint: "/api/webhooks/health",
		},
		platform: {
			port: 5173,
			devCommand: "bun run dev",
			cwd: "apps/platform",
			healthEndpoint: "/",
		},
	},

	envVars: (ports, urls, { localIp }) => ({
		DATABASE_URL: urls.postgres,
		BASE_URL: urls.api,
		VITE_API_URL: urls.api,
		VITE_PORT: ports.platform,
		CLICKHOUSE_NATIVE_PORT: ports.clickhouseSecondary,
		EXPO_PUBLIC_API_URL: `http://${localIp}:${ports.api}`,
		SECRETS_ENV: "dev",
	}),

	migrations: [
		{
			name: "clickhouse",
			command: "bun apps/backend/src/lib/clickhouse/run-ch-migrate.ts",
		},
	],

	seed: {
		command: "bun run run:seeder",
		check: ({ checkTable }) => checkTable("User", "postgres"),
	},

	prisma: {
		cwd: "packages/prisma",
	},
});
```

## Custom Services Example

```ts
import { defineDevConfig, service } from "buncargo";

export default defineDevConfig({
	projectPrefix: "custom",

	services: {
		postgres: service.postgres({
			database: "customdb",
			docker: {
				image: "postgres:16-alpine",
			},
		}),
		rabbitmq: service.custom({
			port: 5672,
			expose: true,
			healthCheck: false,
			docker: {
				image: "rabbitmq:3-management-alpine",
				ports: ["${RABBITMQ_PORT:-5672}:5672", "15672:15672"],
				environment: {
					RABBITMQ_DEFAULT_USER: "guest",
					RABBITMQ_DEFAULT_PASS: "guest",
				},
			},
		}),
		nats: service.custom({
			port: 4222,
			docker: {
				image: "nats:2-alpine",
				ports: ["${NATS_PORT:-4222}:4222"],
			},
		}),
	},

	envVars: (_ports, urls) => ({
		DATABASE_URL: urls.postgres,
	}),

	docker: { volumes: { shared_cache: {} } },
});
```

## Recommended Maintenance Checklist

- Keep `projectPrefix` stable for predictable Docker project names.
- Prefer built-in service helpers over raw Docker objects.
- Keep all connection vars in `envVars`.
- Keep migration/seed commands idempotent.
- Review generated compose diff when changing service settings.
- Add/update tests when adding new custom service patterns.

## Troubleshooting

- **Service has no Docker definition**: use a built-in helper or `service.custom(...)`.
- **Wrong ports**: verify `port` / `secondaryPort` and env var usage.
- **Seed not running**: check `seed.check` return value and service name.
- **Prisma command fails**: confirm `prisma.cwd` and `DATABASE_URL` mapping.
- **Compose file not updating**: set `docker.writeStrategy` to `"always"`.
- **Prisma can't connect**: ensure the service name in `prisma.service` matches a key in `services`.
- **Wrong database URL**: check that `prisma.urlEnvVar` matches an env var defined in `envVars`.
- **Tunnel not starting**: ensure `expose: true` is set on the target, or pass the name explicitly with `--expose=<name>`.
- **Public URL is undefined**: `publicUrls.<name>` is only populated when running with `--expose`; use fallback like `publicUrls.api ?? urls.api`.
