# Architecture

A `dev.config.ts` becomes a `DevEnvironment`. Construction is a read: identity, ports and URLs
are resolved once into a `DevEnvContext` (`src/environment/context.ts`) without touching a runtime.
`start()` then claims the run in `~/.buncargo/runs.json`, prepares the selected services
(Compose up, readiness, migrations, seed), spawns the apps in waves, activates named hosts and
tunnels, and publishes what it started back into the run entry. The CLI (`src/cli/run-cli.ts`)
drives the same environment and adds the terminal: prompts, the banner, the TUI or stream output,
takeover and detach. The machine-wide watchdog and the `ls`/`doctor` commands sweep stacks whose
run has ended. BuncargoBar reads the run registry and shells every mutation out to `buncargo stop`.

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
- [Integrations and stacks](./integrations.md)
- [Shared core](./core.md)
- [Connect](./connect.md)
