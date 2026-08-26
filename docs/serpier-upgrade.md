# Serpier: upgrade buncargo from 3.2.5

Hand this file to whoever owns the Serpier PR. Do not bump `buncargo` until the version you install includes the **shared `env` overlay** (top-level `env` on `defineDevConfig`). Current unpublished `3.2.5` consumers will fail validation if they keep top-level `envVars`.

Audience: [`dev.config.ts`](https://github.com/) on `buncargo@^3.2.5` with Portless, Prisma 7 `--sql`, Mailpit, Typesense, and `bunx buncargo env` in E2E/Playwright.

## When to use this

1. A buncargo release that includes this guide is published (or you point `package.json` at a git/path build that has it).
2. You are ready to change `dev.config.ts` in the same PR as the version bump.

Do not bump HEAD from before this work: top-level `envVars` is rejected and there is no overlay yet.

## Breaking changes

| 3.2.5 | After the bump |
| --- | --- |
| Top-level `envVars: (ports, urls, ctx) => …` | Top-level `env: (ports, urls, ctx) => …` (same callback, new key) |
| `apps.<name>.env: { … }` (constant per-app env) | `apps.<name>.staticEnv: { … }` (same map, new key — matches `ServiceConfig.staticEnv`) |
| `publicUrls` was typed with every service/app key | `publicUrls` is typed with only `expose: true` keys. Reading a non-exposed key is a type error |
| `afterContainersReady` runs `prisma migrate deploy` | `prisma: { cwd }` already runs migrate. **Remove the hook command** or you migrate twice |
| `devCommand` was space-split (no shell) | Commands run through a real shell. `MASTRA_ROLE=worker bun --watch …` is valid inline |
| `service.redis()` / `mailpit()` / `typesense()` accepted `database` / `user` / `password` and ignored them | Those presets no longer accept credential options (their URLs carry none). Use `service.custom({ … })` if you need them |
| `healthCheck: "tcp"` on a preset silently emitted the preset's own healthcheck | `"tcp"` emits **no** container healthcheck; readiness comes from buncargo's host-side TCP probe |
| `options.expoApiApp` / `options.frontendApp` were unchecked | They must match a configured app key, like `options.hosts.primaryApp` |
| Seed scripts that leave sockets/pools open hang `bun dev` | Bun script paths (`bun run ./scripts/seed.ts`) force-exit after the module finishes. You can drop `process.exit()` in `scripts/seed.ts` if you want |
| A failed seed inside `start()` logged and continued; `--seed` exited 1 | One seed path: a failed seed fails `start()` too. `bunx buncargo dev --up-only` starts containers without seeding |
| `bunx buncargo dev --seed` fell back to `bun run run:seeder` with no `seed` block | It now errors with an actionable message. Add `seed: { command: … }` to your config |

`bunx buncargo env` JSON shape is unchanged (`projectName`, `ports`, `urls`, `portOffset`, `isWorktree`, …).

## Required checklist

Copy these in order.

### 1. Bump and install

```bash
# in serpier/
bun add -d buncargo@<version-that-includes-this-guide>
bun install
```

### 2. Rename top-level `envVars` → `env`

Same function body. Only the key changes.

```ts
// before (3.2.5)
envVars: (ports, urls, { publicUrls }) => {
  const usePortless = shouldUsePortlessUrls(process.env, {
    publicApi: Boolean(publicUrls.api),
    publicWeb: Boolean(publicUrls.web),
  })
  const portlessUrls = usePortless
    ? buildPortlessUrls(resolvePortlessSlug())
    : null

  const webUrl = publicUrls.web ?? portlessUrls?.web ?? urls.web
  const apiUrlWithPath = publicUrls.api
    ? `${publicUrls.api}/api`
    : (portlessUrls?.apiBase ?? `${urls.api}/api`)
  const mailpitUrl =
    portlessUrls?.mailpit ?? `http://localhost:${ports.mailpit}`

  return {
    API_PORT: String(ports.api),
    WEB_PORT: String(ports.web),
    DATABASE_URL: urls.postgres,
    DATABASE_URL_PGBOUNCER: urls.postgres,
    WEB_URL: webUrl,
    API_URL: apiUrlWithPath,
    VITE_WEB_URL: webUrl,
    VITE_API_URL: apiUrlWithPath,
    TYPESENSE_URL: urls.typesense,
    TYPESENSE_API_KEY: "xyz",
    REDIS_URL: urls.redis,
    MAILPIT_URL: mailpitUrl,
    SMTP_HOST: "localhost",
    SMTP_PORT: ports.mailpitSecondary,
    ...(usePortless ? { NODE_EXTRA_CA_CERTS: portlessCaPath() } : {}),
  }
},

// after
env: (ports, urls, { publicUrls }) => {
  const usePortless = shouldUsePortlessUrls(process.env, {
    publicApi: Boolean(publicUrls.api),
    publicWeb: Boolean(publicUrls.web),
  })
  const portlessUrls = usePortless
    ? buildPortlessUrls(resolvePortlessSlug())
    : null

  const webUrl = publicUrls.web ?? portlessUrls?.web ?? urls.web
  const apiUrlWithPath = publicUrls.api
    ? `${publicUrls.api}/api`
    : (portlessUrls?.apiBase ?? `${urls.api}/api`)
  const mailpitUrl =
    portlessUrls?.mailpit ?? `http://localhost:${ports.mailpit}`

  return {
    DATABASE_URL_PGBOUNCER: urls.postgres,
    WEB_URL: webUrl,
    API_URL: apiUrlWithPath,
    VITE_WEB_URL: webUrl,
    VITE_API_URL: apiUrlWithPath,
    TYPESENSE_API_KEY: "xyz",
    MAILPIT_URL: mailpitUrl,
    SMTP_HOST: "localhost",
    SMTP_PORT: ports.mailpitSecondary,
    ...(usePortless ? { NODE_EXTRA_CA_CERTS: portlessCaPath() } : {}),
  }
},
```

You can omit `API_PORT`, `WEB_PORT`, `DATABASE_URL`, `TYPESENSE_URL`, and `REDIS_URL` if those services stay named `postgres` / `redis` / `typesense` — buncargo already injects them. Keeping the extras is harmless; they override the computed values.

Do **not** copy this builder onto `apps.api.envVars`, `apps.web.envVars`, and `apps.worker.envVars`. Shared stack URLs belong on top-level `env`.

Because this builder reads `publicUrls.api` and `publicUrls.web`, both apps need `expose: true` — `publicUrls` is now typed from the exposed keys only, so a missing `expose` is a compile error rather than a silent `undefined`.

### 2b. Rename per-app `env` → `staticEnv`

Constant per-app values moved key to stop colliding with the shared `env` overlay:

```ts
// before
api: { port: 3000, devCommand: "…", env: { SECRETS_ENV: "dev" } },

// after
api: { port: 3000, devCommand: "…", staticEnv: { SECRETS_ENV: "dev" } },
```

Validation rejects the old key with an actionable message, so a missed rename fails fast instead of silently dropping the values.

### 3. Stop double-migrating; generate via config

`prisma: { cwd: "packages/db" }` already runs `prisma migrate deploy` after containers.

```ts
// afterContainersReady — delete these two execs
await ctx.exec("bunx prisma migrate deploy --schema ./schema", {
  cwd: "packages/db",
})
await ctx.exec("bunx prisma generate --schema ./schema --sql", {
  cwd: "packages/db",
})

// keep ensureEnvFile + setupPortlessDev in afterContainersReady
```

```ts
prisma: {
  cwd: "packages/db",
  generate: "bunx prisma generate --schema ./schema --sql",
},
```

Portless aliases stay in `afterContainersReady`. `start({ startServers: false })` (`bun dev:up`) never runs `beforeServers`; that is expected.

### 4. Inline the worker env prefix

```ts
worker: {
  port: 3002,
  devCommand: "MASTRA_ROLE=worker bun --watch run src/worker-entry.ts",
  cwd: "apps/api",
},
```

The `package.json` `dev:worker` script can stay for `turbo` / manual runs. You no longer need it only because buncargo lacked a shell.

### 5. Smoke test

```bash
bun run dev:up
bunx buncargo env          # still JSON
bunx buncargo env --get ports.api
bun run dev                # api + worker + web
bun run dev:down
```

Confirm Portless hostnames still work (`PORTLESS` not `0`), and `--expose` still prefers `publicUrls` over Portless (your overlay already does that).

---

## Optional follow-ups

Do these in a later PR if you want a smaller `dev.config.ts`. None are required to boot.

### Presets instead of `service.custom`

```ts
services: {
  postgres: service.postgres({
    database: "postgres",
    docker: { image: "pgvector/pgvector:pg17" },
  }),
  mailpit: service.mailpit({ healthCheck: false }),
  typesense: service.typesense({ apiKey: "xyz" }),
  redis: service.redis({
    docker: { image: "redis:7" },
    healthCheck: "redis-cli",
  }),
},
```

`service.mailpit()` sets `secondaryPort` 1025, `MAILPIT_URL`, `SMTP_PORT`, and `SMTP_HOST=localhost`. Drop the `as ServiceConfig & { secondaryPort: number }` cast and the extra `docker.volumes` entries for mailpit/typesense data (the presets create `mailpit_data` / `typesense_data`).

### Health waits and `--apps`

```ts
api: {
  port: 3000,
  cwd: "apps/api",
  expose: true,
  healthEndpoint: "/api/health",
  requiredApps: ["worker"],
  // …
},
worker: {
  port: 3002,
  cwd: "apps/api",
  healthEndpoint: false,
  // …
},
web: {
  port: 3001,
  cwd: "apps/web",
  expose: true,
  healthEndpoint: "/",
  // …
},
```

Then `bunx buncargo dev --apps=web` does not start the Mastra worker unless you add it to `requiredApps` on web (you probably should not).

### Scripts: `env --get`

E2E / Stripe helpers that parse `bunx buncargo env` with a nested `bun -e` can become:

```bash
API_PORT=$(bunx buncargo env --get ports.api)
WEB_PORT=$(bunx buncargo env --get ports.web)
```

Playwright can keep parsing the full JSON.

### Drop `stty sane` on `dev`

Root `package.json` can be:

```json
"dev": "bunx buncargo dev",
"dev:expose": "bunx buncargo dev --expose"
```

buncargo restores the terminal after attach / supervise.

### Docs in this repo

README and `.capy/settings.json` still say `docker compose up`. Point new hires at `bun dev` / `bun dev:up`. Ignore root `docker-compose.yml` (buncargo writes `.buncargo/docker-compose.generated.yml`).

---

## Optional follow-up: native named hosts (drop Portless)

Once you are on a buncargo release that includes `options.hosts`, you can delete the Portless glue. Do this in a **separate** PR after the required checklist above is green.

### 1. Turn hosts on

```ts
options: {
  hosts: { primaryApp: "web" },
},
```

First `bun dev` prompts for one-time machine setup (mkcert CA + `:443` loopback proxy). `bunx buncargo hosts install` is the non-interactive path. `BUNCARGO_HOSTS=0` or `CI=1` keep `http://localhost:<port>` — Stripe CLI and Playwright stay on loopback with no extra flags.

### 2. Delete Portless glue

- Delete `scripts/lib/portless-dev.ts` (and any `afterContainersReady` that registers Portless aliases).
- Drop Portless branches from the top-level `env` overlay. `urls.web` / `urls.api` / `urls.mailpit` / `urls.typesense` are already named HTTPS when the daemon is up. Keep `publicUrls.*` first so `--expose` still wins:

```ts
env: (ports, urls, { publicUrls }) => {
  const webUrl = publicUrls.web ?? urls.web
  const apiUrlWithPath = publicUrls.api
    ? `${publicUrls.api}/api`
    : `${urls.api}/api`
  return {
    WEB_URL: webUrl,
    API_URL: apiUrlWithPath,
    VITE_WEB_URL: webUrl,
    VITE_API_URL: apiUrlWithPath,
    MAILPIT_URL: urls.mailpit,
    TYPESENSE_URL: urls.typesense,
    // NODE_EXTRA_CA_CERTS is injected by buncargo when hosts are active
  }
},
```

### 3. Vite

- Remove `server.allowedHosts` (and any `.localhost` allow-list). Buncargo injects `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=.localhost`.
- **Keep `changeOrigin: true`** on the `/api` proxy. Without it the named-hosts proxy returns **508 Loop Detected**.

### 4. Leave on loopback

- Stripe webhook listener and the E2E / Playwright stack should keep using `ports.*` / `http://localhost:<port>` (or rely on `CI=1` / `BUNCARGO_HOSTS=0`).
- Stop Portless (`portless proxy stop`) so it does not own `:443`.

Worktree names now come from the **worktree directory**, not the git branch — two checkouts of the same branch get distinct hostnames.

## Leave as-is

- **`.env` bootstrap** (`ensureEnvFile` + `bun run env:link`). Not a buncargo feature.
- **`SERPIER_E2E_NO_INSPECT=1`** for the API inspect port. Optional later: a second `devCommand` or `apps.api.staticEnv`.
- **Magento / Umbraco / mock LLM / mock PostHog** stay outside buncargo unless you promote them to `apps`.

## If something fails

| Symptom | Likely cause |
| --- | --- |
| `Top-level envVars has been removed` | Step 2 not applied |
| `App "…" uses "env", which was renamed to "staticEnv"` | Step 2b not applied |
| `Property 'web' does not exist on type 'Partial<…>'` reading `publicUrls` | That app/service is missing `expose: true` |
| Migrate runs twice / slower `dev:up` | Hook still calls `migrate deploy` |
| Worker never sees Mastra role | Still using a non-shell command, or wrapper script not exporting `MASTRA_ROLE` |
| Seed hangs | Set `seed: { forceExit: true }` or keep `process.exit()` in `scripts/seed.ts` |
| `bun dev` now stops on a seed failure | Intended: fix the seed, or use `dev --up-only` to skip seeding |
| `No seed command is configured` | `--seed` needs a `seed: { command: … }` block |
| `Unknown env path: ports.api` | `bunx buncargo env --get` run outside the repo / no `dev.config.ts` |
