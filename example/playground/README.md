# buncargo playground

A runnable mini project inside the buncargo repository: a Bun API, a Vite frontend and Postgres, all described by `dev.config.ts`. Use it to check the CLI, Compose generation, env injection and dev servers by hand.

## Prerequisites

- [Bun](https://bun.sh) (see root `package.json` engines)
- Docker (for Postgres)

## Setup

From the repository root:

```bash
bun run build
```

The playground depends on the local `buncargo` package via `file:../..`. Install dependencies from this directory:

```bash
cd example/playground
bun install
```

## Run the full dev stack

Run commands from `example/playground`, so `dev.config.ts` and the workspace root resolve:

```bash
cd example/playground
bun run dev
```

Expected behavior:

- Docker Compose is generated under `.buncargo/docker-compose.generated.yml` (relative to this folder; this directory is the workspace root because `package.json` declares `workspaces`).
- Postgres is mapped to host port 5433 by default, so the demo can run next to another Postgres on 5432.
- `api` serves `GET /health` and `GET /api/hello` on the computed `API_PORT` (3010 without a worktree offset).
- `web` serves the Vite app on `WEB_PORT` (5199 without an offset) and calls the API through `VITE_API_URL` from `envVars`. Vite is bound to `127.0.0.1` so IPv4 health checks and `curl http://127.0.0.1:…` work reliably on macOS.

Stop with `Ctrl+C`, or run `bun run dev:down` from another terminal.

### Other scripts

- `bun run dev:up` brings the containers up without starting the app dev servers.
- `bun run dev:down` tears down the dev stack.

## Config import: library authors vs consumers

- Inside this repo, while changing buncargo,, `dev.config.ts` imports from `../../src` so TypeScript tracks the live source.
- As an end user would, switch the import to:

  ```ts
  import { defineDevConfig, service } from "buncargo";
  ```

  The `buncargo` dependency is already declared in `package.json` as `file:../..`; after publishing, you would use a semver version instead.

## Testing local changes to buncargo

1. Edit buncargo under the repo root.
2. Rebuild when you change published artifacts: `bun run build` (from the root).
3. Re-run `bun install` in `example/playground` after a rebuild (or a `package.json` change). Bun snapshots the `file:../..` package; hashed `dist/` chunks go stale otherwise (`Cannot find module '../index-….js'`).
4. Run `bun run dev` again from `example/playground`.

To exercise the CLI entrypoint directly without `bunx`:

```bash
cd example/playground
bun ../../src/cli/bin.ts dev
```

This uses the TypeScript CLI source; pair with the `../../src` config import for a tight feedback loop.

## Public tunnels (optional)

The `api` app sets `expose: true`, so you can try Cloudflare Quick Tunnels.

```bash
cd example/playground
bun run dev -- --expose       # tunnel all expose:true targets (here: api)
bun run dev -- --expose=api   # tunnel only api
```

On first use, `cloudflared` is downloaded unless it is already cached. Naming an app (`--expose=api`) limits tunneling to that app.

See `example/AGENTS.md` for conventions.
