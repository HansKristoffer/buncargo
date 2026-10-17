# Architecture

A `dev.config.ts` becomes a `DevEnvironment`. Construction is a read: identity, ports and URLs
are resolved once into a `DevEnvContext` (`src/environment/context.ts`) without touching a runtime.
`start()` then claims the run in `~/.buncargo/runs.json`, prepares the selected services
(Compose up, readiness, migrations, seed), spawns the apps in waves, and publishes what it
started back into the run entry; tunnels open only when the caller asks (`openPublicTunnels()`).
The CLI (`src/cli/run-cli.ts`) drives the same environment and adds the terminal: prompts, the
banner, the TUI or stream output, takeover and detach. The machine-wide watchdog and the
`ls`/`doctor` commands sweep stacks whose run has ended. BuncargoBar reads the run registry and
shells every mutation out to `buncargo stop`.

## What only `buncargo dev` does

`runDevFlow` does more than `start()`, by decision rather than oversight: named hosts
(`cli/dev-hosts.ts`; `start()` leaves `env.urls` on `localhost:port`), the fast checks and
integration `preflight` steps, connect sharing, the per-run logs and the requests `restart`,
`send` and `logs` act on, and parking an app that never came up. Each one belongs to a long-lived
run that a person or agent started: it asks at a terminal (preflight, takeover), claims
machine-wide state held by that process until it exits (host routes, connect), or describes that
process to other tools. A library `start()` runs inside a test or script buncargo does not own,
often many sessions to one process.

Two crossed the line on purpose. `exclusive` leases: without one, a `start()` and a `dev` both ran
one exclusive app; `start()` takes them per session and answers a held one the way `dev` does
without a terminal, never with a takeover. And the app rows `ls`, `stop` and BuncargoBar read: an
app-only `start()` was invisible to all three. The user-facing list is in `docs/reference.md`
(Programmatic API); keep it in step when a behavior crosses this line, and port one to `start()`
only on purpose.

## Ownership

- `~/.buncargo/runs.json` is the one liveness record. Claim the run before preparation; the sweep
  never sees a fresh stack as unowned. See [run registry and sweep](./run-registry-and-sweep.md).
- Reconciliation and the sweep share a per-project lock and recheck live owners. One run exiting
  must never condemn another run's services.
- A container is cheap to recreate; a volume is the database. Nothing removes volumes without an
  explicit, confirmed command.
- Own child process groups from spawn through readiness and shutdown. Signals cancel preparation,
  builds, health probes and tunnel opening; await bounded TERM/KILL cleanup before the CLI exits.
  Cleanup failures must not mask the original failure or skip other cleanup.
  See [process supervision](./process-supervision.md).

## Startup invariants

- Build and write one Compose artifact per start. Publish generated YAML atomically and keep its
  inode when unchanged. Never hash a different model from the file handed to Docker.
- Startup plan validation precedes hosts and runtime mutations. `requiredApps` expands the
  selection; it is not a per-app readiness barrier. Both waves are health-checked once; server
  hooks wrap actual spawning and readiness on the CLI and library paths.
- `prisma.generateCheck` is opt-in: true means generate. Never automatically skip database
  migrations or seed checks from a configuration hash.
- Package verification installs the exact release tarball into a clean consumer, and that
  verified artifact is what gets published, with scripts disabled. CI covers macOS/Linux, the
  minimum and current Bun, schema consumers and disposable Docker integration. Privileged hosts
  installation and Apple VM testing remain external runner checks.

## Monorepo startup

- `readme.md` documents app-only selection, workers, finite jobs, preparation ordering, checkout
  execution and dotenv precedence. Keep its examples and option tables aligned with the public types.
- `context.prepareStart` validates the selection and resolves and probes infrastructure only for
  selected services, before host mutations. App-only runs do not write Compose or claim containers.
- `beforeMigrations` precedes Prisma and ordered custom migrations. Migration and seed
  `requiredServices` scope preparation; omitted prerequisites prepare whenever a service is
  selected, while `[]` explicitly permits app-only work. `afterPreparation` uses a second
  container subset after preparation, with `noDeps` to avoid rerunning completed early jobs.
- Workers have no endpoint. `process/worker-ownership.ts` atomically claims per-checkout PID and
  birth identity before supervision; CLI reuse/takeover and library duplicate refusal must not
  permit duplicate consumers. An unexpected worker exit zero is a failure.
- Jobs require `kind: "job", rerun: "always"`; exited zero satisfies completion, running does not.
  Apple rejects jobs before mutation until it can report trustworthy exit codes. Compose
  completion references must target jobs.
- `core/env-input.ts` is the only dotenv input loader. It returns an isolated root-relative
  snapshot after config evaluation. Shared generated values beat defaults; app overrides stay
  last. `exec` uses the existing argv execution primitive and persisted ports, without startup or
  probes.

## Topics

- [Glossary](./glossary.md)
- [CLI](./cli.md)
- [Environment and preparation](./environment.md)
- [Process supervision](./process-supervision.md)
- [TUI and app output](./tui.md)
- [Run registry, sweep and BuncargoBar](./run-registry-and-sweep.md)
- [Container runtimes](./container-runtimes.md)
- [Ports](./ports.md)
- [Named hosts](./named-hosts.md)
- [Secrets](./secrets.md)
- [Checkout files](./checkout-files.md)
- [Integrations and stacks](./integrations.md)
- [Shared core](./core.md)
- [Connect](./connect.md)
