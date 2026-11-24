# Buncargo

Bun-first library and CLI for local dev environments across many Git worktrees at once (`dev.config.ts` → isolated ports, containers, databases, `https://*.localhost` hosts, supervised apps, cleanup). `menubar/` is BuncargoBar, a macOS menu bar reader.

## Non-negotiables

1. **Checkout isolation:** Two worktrees never share a port, container, database, hostname or state file.
2. **Data survives:** Containers are disposable; volumes are databases. Only an explicit confirmed command (`prune`, `gc`, `dev --reset`) or `BUNCARGO_PRUNE_DELETED_CHECKOUTS=1` (deleted checkouts only) removes a volume; one run ending never downs another run's services.
3. **Fast startup:** Paid on every worktree start. Count spawned processes before startup and measure with `buncargo dev --timing`.
4. **Reliable named hosts:** Silent fallback to `localhost:port` is a bug, never flakiness.
5. **Agent-drivable:** Every flow works non-interactively (`--detach`, `--yes`, `--json`, distinct exit codes). Keep `src/cli/agents-guide.ts` (`buncargo help agents`) true when CLI behavior changes.

## Guardrails (live machine state)

This machine runs real dev environments alongside your worktree:

1. **Sweep isolation:** Never run the sweep, watchdog, `gc`, or `dev --down --all` with an isolated `HOME` against a reachable Docker daemon — it treats every real stack as unowned. Stub adapters or point `DOCKER_HOST` at nothing. Never empty `PATH` (Bun falls back to `/usr/bin/docker`; `src/architecture.test.ts` rejects it). `bun test` isolates via `scripts/test-runtime-isolation.ts`.
2. **Unlabelled volumes:** Leave Compose volumes unlabelled (labels make Compose prompt and hang non-interactive runs).
3. **Targeted stops:** Stop only pids you captured or via `buncargo stop`. Never `pkill -f`, `killall`, or `docker rm` by name.
4. **Live host state:** Keep `~/.buncargo`, `/etc/hosts`, the hosts daemon and its certs untouched in tests (inject seams). Never run `sudo`, `dev --reset`, or `dev --down --all` to "fix" state.

## Hit every surface

Before finishing, check which surfaces apply and cover all of them:

- **CLI & library:** `runDevFlow` (`src/cli/run-cli.ts`) and `start()` (`src/environment/`).
- **Runtimes:** Docker (`src/docker/`) and Apple `container` (`src/apple-container/`) behind `ContainerRuntimeAdapter`.
- **Output modes:** Stream mode and TUI (rendering, `restart`, `send`, per-run logs).
- **Registry readers:** `runs.json` changes update `menubar/fixtures/runs.v2.json` (tested by both TS and Swift).
- **Machine contracts:** `--json` (`src/cli/json-documents.ts`), exit codes, and `buncargo help agents`.
- **Reverse states:** Every way in needs a way out and a way to inspect it (claim/release/stop, setup/uninstall, takeover/reuse).
- **Integrations:** Expo, Shopify, Supabase and Firebase reach core only via `BuncargoIntegration` hooks.
- **Docs:** Update `readme.md`, `docs/reference.md`, `docs/migration.md` (breaking changes) and affected `docs/internals/` notes (rewrite in place; never append).

## Context pointers (read before changing a subsystem)

- **Code layout, architecture & startup invariants:** `docs/internals/overview.md`
- **Concern owners, types & code style:** `CODING_STANDARDS.md` (import directories through `index.ts`; reach shared concerns through their owner)
- **Terminology (checkout, run, claim, release, stop, retire, sweep):** `docs/internals/glossary.md`
- **Runs, `runs.json`, `stop`, sweep, `gc`, watchdog, volumes, BuncargoBar:** `docs/internals/run-registry-and-sweep.md`
- **Named hosts, certs, proxy, `/etc/hosts`:** `docs/internals/named-hosts.md`
- **Compose generation, `container-runtime/`, Docker & Apple backends:** `docs/internals/container-runtimes.md`
- **Port allocation, offsets, port owners:** `docs/internals/ports.md`
- **Spawning, waves, restarts, workers, leases:** `docs/internals/process-supervision.md`
- **TUI, PTYs, app output & logs:** `docs/internals/tui.md`
- **Environment, seeding, captures, Prisma:** `docs/internals/environment.md`
- **CLI commands, flags, takeover, detach, `check`, typecheck:** `docs/internals/cli.md`
- **Infisical secrets:** `docs/internals/secrets.md`
- **Checkout files (`buncargo files`, agentgate contract):** `docs/internals/checkout-files.md`
- **Integrations & stacks (Expo, Shopify, Supabase, Firebase):** `docs/internals/integrations.md`
- **State paths, locks, `runtime-flags.ts`, prompts:** `docs/internals/core.md`
- **frp sharing (`connect`):** `docs/internals/connect.md`
- **Opt-in suites & CI parity:** `docs/testing.md`
- **PRs & Release Please rules:** `docs/releasing.md` and `.github/pull_request_template.md`
- **Diff review & real playground verification:** `.agents/skills/review-buncargo/SKILL.md` and `.agents/skills/verify-buncargo/SKILL.md`

## Workflow & verification

- Fresh worktree: run `bun install` (also installs `.githooks/` pre-commit lint; never commit with `--no-verify`).
- Iterate with `bun test <files>`. Prefer hermetic tests over running `example/playground` (stop playground runs with `buncargo stop --all`).
- Before finishing: `bun run build`, `bun run lint:write`, and `bun run test` must all pass. Before opening/updating a PR: run `bun run ci:local` (about 2 min; ends in `PASS`). Multi-commit branches: `bun scripts/check-commits.ts <base>`.
- Review the branch diff with the `review-buncargo` skill before handing back.
- Tests: co-located `*.test.ts`; await events/deadlines or inject clocks (no sleeps); allocate ports with `freePorts` (`src/core/test-env.testing.ts`); clean up temp dirs (restoring `0o700` on unreadable fixtures via `removeTempDir`); fix violations of `src/architecture.test.ts` rather than widening allow-lists.

## Compatibility, PRs & scratch

- **Breaking changes:** Hard cutovers in major releases — no aliases, legacy readers, or deprecation periods. Document in `docs/migration.md`.
- **PRs:** Open only when asked. Use conventional commit titles with scope (`fix(hosts):`, `feat(cli):`, `feat(cli)!:`, `bar` for `menubar/`). Keep PR bodies plain prose and `-` bullets (no fenced code blocks or `word(scope):` lines, which break Release Please). Never edit `package.json` `version`, `menubar/version.txt`, or `CHANGELOG.md`.
- **Scratch/plans:** Keep out of git (`.plans/` is gitignored).
