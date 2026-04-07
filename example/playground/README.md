# buncargo playground

Runnable mini project inside the buncargo repository: a Bun API, a Vite frontend, and Postgres via `dev.config.ts`. Use it to manually verify the CLI, Docker compose generation, env injection, and dev servers.

## Prerequisites

- [Bun](https://bun.sh) (see root `package.json` engines)
- Docker (for Postgres)

## Setup

From the **repository root**:

```bash
bun run build
```

The playground depends on the local `buncargo` package via `file:../..`. Install dependencies from this directory:

```bash
cd example/playground
bun install
```

## Run the full dev stack

Always run commands from **`example/playground`** (so `dev.config.ts` and the workspace root resolve correctly):

```bash
cd example/playground
bun run dev
```

Expected behavior:

- Docker Compose is generated under `.buncargo/docker-compose.generated.yml` (relative to this folder; this directory is the workspace root because `package.json` declares `workspaces`).
- Postgres is mapped to host port **5433** by default so you can run this demo next to another Postgres on **5432**.
- **api** serves `GET /health` and `GET /api/hello` on the computed `API_PORT` (defaults to **3010** without a worktree offset).
- **web** serves the Vite app on `WEB_PORT` (defaults to **5199**); it calls the API using `VITE_API_URL` from `envVars`. Vite is bound to `127.0.0.1` so IPv4 health checks and `curl http://127.0.0.1:…` work reliably on macOS.
- Multiple apps require **`concurrently`** (listed in this folder’s `package.json`); `buncargo dev` runs `bun concurrently …` to start every app process.

Stop with `Ctrl+C` (or use `bun run dev:down` from another terminal if documented in your workflow).

### Other scripts

- `bun run dev:up` — bring containers up without starting app dev servers (per buncargo CLI).
- `bun run dev:down` — tear down the dev stack.

## Config import: library authors vs consumers

- **Inside this repo** (while changing buncargo), `dev.config.ts` imports from `../../src` so TypeScript tracks the live source.
- **As an end user** would, switch the import to:

  ```ts
  import { defineDevConfig, service } from "buncargo";
  ```

  The `buncargo` dependency is already declared in `package.json` as `file:../..`; after publishing, you would use a semver version instead.

## Testing local changes to buncargo

1. Edit buncargo under the repo root.
2. Rebuild when you change published artifacts: `bun run build` (from the root).
3. Re-run `bun install` in `example/playground` if you change `buncargo`’s `package.json` (name, exports, bin).
4. Run `bun run dev` again from `example/playground`.

To exercise the CLI entrypoint directly without `bunx`:

```bash
cd example/playground
bun ../../src/cli/bin.ts dev
```

This uses the TypeScript CLI source; pair with the `../../src` config import for a tight feedback loop.

## Public tunnels (optional)

The **api** app is configured with `expose: true` so you can test Cloudflare Quick Tunnels.

```bash
cd example/playground
bun run dev -- --expose       # tunnel all expose:true targets (here: api)
bun run dev -- --expose=api   # tunnel only api
```

On first run, `cloudflared` may be downloaded if it is not already cached.

See `example/AGENTS.md` in the parent folder for details.

Both `--expose` and `--expose=api` enable tunneling (the latter limits which app is tunneled when you pass a name).
