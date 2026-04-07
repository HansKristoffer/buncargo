# Example `dev.config.ts` files

This folder contains example configurations for `buncargo`.

- **[`playground/`](playground/)**: Runnable workspace (Postgres + Bun API + Vite UI) with its own `package.json`. Use it to manually test the CLI end-to-end; see [`playground/README.md`](playground/README.md).
- `minimal.dev.config.ts`: Smallest working setup with one built-in service.
- `platform.dev.config.ts`: Typical multi-service + multi-app platform setup.
- `custom-services.dev.config.ts`: Shows helper and raw custom Docker service definitions.
- Public exposure via `expose: true` can be combined with `bunx buncargo dev --expose`.

Recommended style:

- Use `service.postgres()`, `service.redis()`, `service.clickhouse()` for built-ins.
- Use `service.custom({ port, docker: { ... } })` for everything else.

Copy one file into your repo root as `dev.config.ts` and adjust values for your project.
