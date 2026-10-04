# Supabase support plan

Status: built 2026-10-04, as one change rather than phases. The spikes against Supabase CLI 2.119.0 (the TypeScript rewrite) changed the plan in four places:

- **No ownership-label seam.** The CLI labels every container `com.docker.compose.project=<project_id>`, so passing buncargo's project name as the id makes the existing ownership check read the stack as ours. The only addition is `externalStackProjectName`, because the CLI cuts ids at 40 characters and worktree project names are often longer. `docker compose down` leaves those containers alone (they have no service label).
- **Phase 1's stopgaps were skipped.** Ports come from the allocator and the stack starts through the `stacks` seam directly, rather than `portOffset` arithmetic and a "supabase start" migration entry.
- **No fast paths.** `supabase start` on a running stack takes 0.8s and `migration up` with nothing to apply 0.3s, so the `docker ps` shortcut and the Bun SQL migration check were not built.
- **Keys are derived.** Signing the CLI's demo claims with the default secret reproduces its anon and service-role keys byte for byte; the publishable and secret keys are constants.

`--reset` keeps buncargo's meaning (tear down and delete the data; the next start reseeds) instead of `supabase db reset`. Still unverified: the API behind a named HTTPS host with Realtime websockets, and the experimental `supabase stack` runtime. The rest of this document is the plan as written.

## Where we are

Buncargo has no Supabase awareness. A project using Supabase today runs `supabase start` beside `buncargo dev`, and almost everything buncargo is good at stops at that boundary:

- **Worktrees collide.** The Supabase CLI names containers, volumes and the network after `project_id` from the committed `supabase/config.toml` (`supabase_db_<id>`), and binds fixed ports (54321 API, 54322 DB, 54323 Studio, 54324 mail…). A second worktree either reports "already running" and silently talks to the first worktree's database, or fails on the ports.
- **Env is copy-paste.** `SUPABASE_URL`, the anon/service-role keys and `DATABASE_URL` live in hand-written `.env` files with port 54321 baked in, so they are wrong in every worktree but one.
- **Auth redirects are wrong per worktree.** `auth.site_url` and `additional_redirect_urls` are fixed in `config.toml`, so magic links and OAuth return to the wrong checkout, or to `localhost:3000` when the app is on a named host.
- **Migrations go stale.** `supabase start` applies migrations and `seed.sql` only to a fresh volume. After a `git pull` with new migrations the developer has to remember `supabase migration up`.
- **Lifecycle is invisible.** The watchdog's idle hold, `dev --down`, `--reset`, `ls`, `doctor`, the run registry and BuncargoBar know nothing about these containers.
- **Declaring the ports in buncargo would make it worse.** A port counts as ours only when the container's `com.docker.compose.project` label equals our project name (`core/process/port-owner.ts`). Supabase containers carry `com.supabase.cli.project`, so the allocator would see its own stack as a foreign occupant and shift the block by 100 on every warm start.

### Supabase's own experimental stack runtime

CLI v2.119.0 (2026-09-30) ships a new local runtime behind a flag (`[experimental] stack = true` or `SUPABASE_EXPERIMENTAL_STACK=1`; commands `supabase stack start|stop|status|list|destroy`). It is documented as unstable and outside the CLI's compatibility promise.

- Stack identity is a hash of the project root, the current git branch and a stack name (`docs/adr/0017-…` in supabase/cli), so each worktree gets its own stack. So does each branch inside one checkout, which means switching branches starts a fresh, empty database.
- Ports missing from `config.toml` are allocated automatically and kept across restarts. Ports that are present, including ones set through environment interpolation, are honored exactly. `supabase init` writes all of them.
- It can run on Docker, Podman, or natively without a container engine.

It isolates Supabase. It does nothing for the project's own app ports, getting URLs and keys into each app's env, or redirect URLs pointing at this worktree's frontend. That half is what buncargo adds, with either runtime.

## Recommendation

Ship `buncargo/supabase` as an **integration that drives the Supabase CLI**, starting with a version that needs **no core changes**. Add core seams only for what that version cannot reach. Do not reimplement the Supabase stack as a compose preset.

The fact that makes this cheap: the CLI loads `config.toml` through viper with `SetEnvPrefix("SUPABASE")`, a `.` → `_` key replacer and `AutomaticEnv()` (`apps/cli-go/pkg/config/config.go`, `loadFromFile`). Every config key can be overridden per process: `SUPABASE_PROJECT_ID`, `SUPABASE_API_PORT`, `SUPABASE_DB_PORT`, `SUPABASE_AUTH_SITE_URL`, … Buncargo never rewrites or copies `config.toml`.

**One path for both runtimes:** buncargo always passes explicit, worktree-derived ports. The experimental runtime honors explicit ports exactly, so the same env works on both, and nothing in the integration depends on which runtime runs underneath. CLI output is read only where a value cannot be derived (possibly the new publishable/secret keys, see spikes).

Why not a compose preset of the whole stack: about ten images (Postgres, GoTrue, PostgREST, Realtime, Storage, imgproxy, Kong, Studio, pg-meta, mail, edge runtime, analytics) with a Kong config, JWT key material and internal-schema bootstraps that the CLI pins and changes between releases. We would chase that forever and still lose what people use the CLI for: `db diff` against a shadow database, `gen types`, `functions serve`, `config.toml` auth settings.

### What the config looks like

```ts
import { defineDevConfig } from "buncargo";
import { supabase } from "buncargo/supabase";

export default defineDevConfig({
	projectPrefix: "myapp",
	services: {},
	integrations: [
		supabase({
			// Framework-prefixed copies of SUPABASE_URL / SUPABASE_ANON_KEY.
			publicEnvPrefix: "VITE_",
		}),
	],
	apps: {
		web: { port: 5173, devCommand: "bun run dev" },
	},
});
```

## Phase 1 — integration only, no core changes

Everything here uses primitives that exist today.

1. **Read `supabase/config.toml` leniently** in `config()` (Bun's TOML import): `project_id`, enabled components, base ports, `auth.jwt_secret`. A missing file leaves a working config and a failing check, per the integration guidelines.
2. **Ports from the project's offset, not the allocator.** The env builder's context already carries `portOffset`, so each port is `config.toml base + portOffset`. Buncargo never probes these ports, so it never mistakes its own stack for a foreign occupant. The gap: there is no conflict detection, so a clash surfaces as `supabase start` failing with the CLI's own port error. Offsets are hashed per project and worktree, so a clash is rare. Phase 2 closes the gap.
3. **Env, all derived, so it is pure and available to `buncargo exec` without the stack running:**
   - For the CLI: `SUPABASE_PROJECT_ID` = buncargo's project name (worktree-unique), one `SUPABASE_*_PORT` per enabled component, `SUPABASE_AUTH_SITE_URL` (the primary app's URL), `SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS` (every app's named, loopback and public URL).
   - For apps: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, and the `publicEnvPrefix` copies. Expo apps get the LAN address so a device can reach the API.
   - The anon and service-role keys are HS256 JWTs signed with `auth.jwt_secret` (the CLI's well-known default unless set). Sign them with `node:crypto`'s `createHmac`, which is synchronous like the env builder.
   - Because the CLI's env is in the shared env, `buncargo exec -- supabase db diff` already targets this worktree's stack. `buncargo supabase <args>` is the obvious spelling of that passthrough; a bare `supabase` in a worktree is a footgun.
4. **Start and migrate as migration entries.** `{ name: "supabase start", command: "supabase start", requiredServices: [] }` followed by `supabase migration up --local`. `requiredServices: []` is what lets them run in an app-only run, and migration commands get the shared env. A start on an already-running stack is a fast no-op (spike). Missing new migrations after a pull is fixed by this alone.
5. **Stop.** `hooks.beforeStop` runs `supabase stop`, so `dev --down` covers the stack. `--reset` cannot be told apart from `--down` in a hook, so a reset is `buncargo supabase reset` (`supabase db reset`: reruns migrations and `seed.sql` in place, much faster than recreating the containers).
6. **Checks.** CLI on `PATH` (fast: binary lookup only); version in a tested range (`fast: false`); `config.toml` present; with `docker.runtime: "apple"`, fail with "the Supabase CLI needs Docker or Podman" instead of a connection error. A warning when an app's dotenv hard-codes a `SUPABASE_URL` that disagrees with the derived one.
7. **Surfaces.** `describe` rows for API, Studio, mail and DB, so `buncargo url`, `open "supabase studio"`, the banner and BuncargoBar show them.
8. **Edge functions (opt-in).** `functions: true` adds a `supabaseFunctions` worker running `supabase functions serve`, `essential: false`, restartable with `r`.

What phase 1 cannot do: named HTTPS hosts for Studio and the API, `--expose`, remote sharing, Prisma or Drizzle pointed at the Supabase database through `prisma.service`, the TablePlus link, `--up-only` (containers-only mode skips preparation, so it skips the start), and cleanup by the watchdog. All of these need buncargo to know the stack's endpoints as services.

## Phase 2 — core seams (generic, no Supabase in core)

Core reaches integrations only through declared members; these keep it that way.

9. **External services.** A `ServiceConfig` whose endpoint something else provides (`docker: false`, or a `provider` field). Buncargo allocates and probes its port, gives it `ports`/`urls`/env aliases, named hosts, `--expose`, remote sharing, the run registry and a host-side health check, and emits nothing into the compose file. `requiredServices`, `prisma.service` and selection work unchanged. Service identity (`core/service-identity.ts`) takes an explicit kind, so an external Postgres still gets its TablePlus link and the Prisma migrations-applied shortcut.
10. **Ownership labels.** A stack declares that containers whose `<label>` equals our project name are ours. `docker/port-lookup.ts` reads that label beside `com.docker.compose.project`, and the allocator, `assertServicePortsClaimable`, `classifyCliApps` and the spawner treat a match as `reuse`. Required by item 9: once buncargo probes these ports, it must recognize its own stack.
11. **Stack lifecycle.** `up(ctx)` runs in the container phase whenever one of the stack's services is selected, concurrently with `compose up`, and cancellable. This replaces the migration-entry hack of item 4 and makes `--up-only` work. `down` is **argv** recorded in the run entry, so it can run without loading the config. `reset(ctx)` is optional and backs `--reset`.

Keep the shape minimal: one `stacks` member on `BuncargoIntegration`, not a new top-level config key, until a second user exists.

With these, the integration moves its endpoints to external services (`supabaseApi`, `supabaseDb`, `supabaseStudio`, `supabaseMail`), takes ports from the allocator instead of `portOffset`, and gets:

- **A fast warm start.** One `docker ps` by `com.supabase.cli.project=<project>`; when every enabled component is running, skip the CLI. Otherwise `supabase start -x <excluded>` with the resolved Infisical secrets in its env, for `env(...)` references in `config.toml`. An `exclude` option, with a CI default that drops Studio, imgproxy, analytics and the edge runtime, which is most of a cold start.
- **Migrations skipped when current.** Compare `supabase/migrations/*.sql` versions with `supabase_migrations.schema_migrations` over Bun SQL, generalizing `prisma/migrations-applied.ts`; any uncertainty runs the CLI.
- **`SUPABASE_API_EXTERNAL_URL`** set to the named host, so storage URLs and auth email links use it.
- **Types (opt-in).** `types: { output }` runs `supabase gen types typescript --local` after migrations, skipped when the migration set's hash is unchanged and the output exists, and written through `generated-files.ts` so unchanged content is not rewritten.

## Phase 3 — lifecycle parity

12. **Sweep.** The recorded stack (`label`, `down` argv, binary) lets `sweepOrphanedContainers` list those containers and apply `decideSweep` unchanged. `supabase stop --project-id <id>` keeps volumes, matching buncargo's rule that volumes are never removed automatically. `ls` and `doctor` show the stacks.
13. **CI.** `buncargo ci`'s suffixed environment gives `SUPABASE_PROJECT_ID=<project>-ci`, so its teardown (`supabase stop --no-backup`) can never touch the developer's stack.

## Spikes before building

Short scripts against a real CLI; each decides part of the design. The first four gate phase 1.

- Do `SUPABASE_*_PORT` overrides reach every port, including `db.shadow_port`, the pooler and the edge-runtime inspector? How does a list (`additional_redirect_urls`) parse from one env var?
- Can two stacks with different `SUPABASE_PROJECT_ID`s run side by side from two worktrees?
- Is `supabase start` on an already-running stack fast and exit 0?
- On the experimental runtime: are explicit ports from env honored, and what happens on a branch switch while the previous branch's stack holds the same ports (the design says "conflict only while occupied")? Are the `sb_publishable_…` / `sb_secret_…` keys fixed defaults or per stack?
- Cold and warm start times, which decide whether phase 2's fast path is worth its code.
- The API on a named HTTPS host through the proxy: Realtime websockets, storage uploads, auth redirects.

## Not recommended

- A compose preset of the full stack (above).
- A per-worktree copy of `config.toml` with `--workdir`: the env overrides make it unnecessary, and a copy drifts from the file people edit.
- A `service.postgres({ image: "supabase/postgres" })` variant: nobody has asked, and the integration covers the same projects better.

## Open questions

- Which Supabase features do the projects that would use this rely on (auth, storage, realtime, edge functions)? Do they migrate with `supabase migration` or with Prisma/Drizzle? Prisma/Drizzle users need phase 2 before the integration is much use to them.
- Is one `stacks` member on the integration API acceptable for phase 2, or should Supabase live in core like Prisma?
