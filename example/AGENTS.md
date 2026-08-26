# Example workspace notes

The root [readme.md](../readme.md) is the canonical buncargo reference. Read that before writing or changing a `dev.config.ts`.

This folder is only for in-repo examples and playground conventions.

## Files

- [`minimal.dev.config.ts`](minimal.dev.config.ts) — one Postgres service
- [`platform.dev.config.ts`](platform.dev.config.ts) — API + Vite + Expo
- [`custom-services.dev.config.ts`](custom-services.dev.config.ts) — custom Docker services
- [`playground/`](playground/) — runnable workspace for manual CLI tests

## Conventions in this repo

- Example configs import from `../src` (or `../../src` in the playground) so types match the branch you are working on. External projects should import from `buncargo`.
- Do not maintain a hand-written root `docker-compose.yml`. Generated compose lives at `.buncargo/docker-compose.generated.yml`.
- Prefer `service.postgres()`, `service.redis()`, `service.clickhouse()`, `service.mailpit()`, and `service.typesense()` for built-ins. Use `service.custom(...)` for everything else.
- Shared stack env (rewritten `WEB_URL`, `VITE_*`) belongs on top-level `env`. App-only values belong on `apps.<name>.envVars` when computed, or `apps.<name>.staticEnv` when constant.
- Set `healthEndpoint` on HTTP apps (`"/api/health"`, `"/"`). Use `healthEndpoint: false` for workers / Metro.
- Use `requiredApps` / `requiredServices` so `--apps=web` does not start unrelated processes.
- After `interactive` / `--attach`, buncargo restores the terminal (`stty sane`).
- Copy the closest example into a real project as `dev.config.ts` and change `projectPrefix` plus service/app names.

## Useful scripts for a consumer project

```json
{
  "scripts": {
    "dev": "bunx buncargo dev",
    "dev:up": "bunx buncargo dev --up-only",
    "dev:down": "bunx buncargo dev --down",
    "dev:expose": "bunx buncargo dev --expose",
    "dev:env": "bunx buncargo env",
    "dev:with-api": "bunx buncargo dev --apps=expoApp",
    "prisma": "bunx buncargo prisma"
  }
}
```
