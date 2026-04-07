# Buncargo Contributor Guide

## Purpose

`buncargo` is a Bun-first library/CLI for local development environments:
- Docker Compose service orchestration
- App/dev-server process orchestration
- Worktree-aware ports and project identity
- Typed config and programmatic environment access

This file defines how to structure code and how to implement changes consistently.

## Project Structure

All library source code lives under `src/`.

- `src/index.ts`
  - Public API aggregation for library consumers.
- `src/cli/`
  - CLI runtime and command handlers.
  - `bin.ts` is the CLI executable entrypoint.
  - `index.ts` is the canonical CLI module entry.
  - `run-cli.ts` contains core CLI flow.
  - `commands/` contains command-specific behavior (`dev`, `env`, `prisma`, etc.).
- `src/config/`
  - Dev config API and validation.
  - Keep definition, validation, and merge logic split by responsibility.
- `src/environment/`
  - `createDevEnvironment()` and related orchestration helpers.
  - Prefer extracting complex concerns into focused modules (e.g. logging/seeding).
- `src/loader/`
  - Config discovery/loading and cache handling.
- `src/typecheck/`
  - Workspace typecheck orchestration.
- `src/prisma/`
  - Prisma-specific integration layer.
- `src/docker-compose/`
  - Compose generation only (model building, YAML serialization, generated-file logic).
  - `services/` contains built-in service presets/helpers.
- `src/docker/`
  - Docker runtime operations only (up/down/health/container checks).
- `src/core/`
  - Shared runtime utilities (network, ports, process, utils, watchdog).
- `src/types/`
  - Type surface canonical source (via `all-types.ts` + `index.ts`).

## Canonical Imports

- Prefer directory index modules over ad-hoc wrapper files.
- Canonical examples:
  - `./config/index`
  - `./environment/index`
  - `./loader/index`
  - `./typecheck/index`
  - `./types/index`
- Do not reintroduce thin top-level wrapper files that only re-export another module.

## Architectural Rules

1. Keep Docker concerns separated:
   - `src/docker-compose/*` = compose artifact generation.
   - `src/docker/*` = runtime container operations.
2. Keep modules single-purpose:
   - If a file grows large or mixes concerns, split it.
3. Keep public API stable through `src/index.ts`:
   - New public exports should be intentionally added there.
4. Keep tests co-located with code:
   - Use `*.test.ts` in the same folder as the module under test.
5. Prefer composition over monolith files:
   - Extract helpers for logging, seeding, command handling, etc.

## Coding Standards

- Use TypeScript strict mode patterns.
- Prefer small, pure helper functions where possible.
- Keep function and file names descriptive and domain-oriented.
- Use existing shared utilities before introducing new duplicates.
- Avoid hidden side effects; keep I/O boundaries explicit.
- Keep import paths aligned to the current folder architecture (no legacy root paths).
- Add comments only when logic is non-obvious.

## API and Behavior Changes

- Treat changes to `src/index.ts`, CLI command behavior, and exported types as high-impact.
- If changing behavior, update/extend tests in the same change.
- Keep error messages actionable and user-oriented.

## Validation Checklist (for every substantive change)

Run before finishing:

1. `bun run build`
2. `bun run lint:write`
3. `bun test`

If relevant, also run:

4. `bun run lint`

Do not leave the repo in a state where build/tests fail.

## Cloudflared tests (co-located)

- **[`src/cli/run-cli.test.ts`](src/cli/run-cli.test.ts)** — `runCli expose routing`: stub `DevEnvironment` and `cliTestTunnel` assert `startPublicTunnels` runs only when `--expose` is present (no cloudflared).
- **[`src/core/quick-tunnel/quick-tunnel.test.ts`](src/core/quick-tunnel/quick-tunnel.test.ts)** — **Smoke** (public HTTPS URL from `getURL()`) runs with default `bun test`: needs **network**; first run may download `cloudflared` (tests pass `acceptCloudflareNotice`). **E2E** (curl through `*.trycloudflare.com`) is **skipped** unless `BUNCARGO_TEST_CLOUDFLARED_E2E=1` — routing/DNS are unreliable on some networks and in sandboxes.

Convenience scripts (only that file):

```bash
bun test src/core/quick-tunnel/quick-tunnel.test.ts
# include E2E:
bun run test:integration-cloudflared-e2e
```

GitHub Actions: [`.github/workflows/integration-cloudflared.yml`](.github/workflows/integration-cloudflared.yml) is **workflow_dispatch** only (manual run from the Actions tab); sets `BUNCARGO_TEST_CLOUDFLARED_E2E=1` for the full suite.
