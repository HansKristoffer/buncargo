# Shared core

Cross-cutting utilities in `src/core/` that most features touch.

## Environment and state

- `runtime-flags.ts` is the only place `BUNCARGO_*` and `CI` are read. Every getter takes the
  environment as its last argument (defaulting to `process.env`), so tests inject a plain object
  and nothing is captured at import time. CI detection is `isCI()` (`CI=1|true`, `GITHUB_ACTIONS`,
  `GITLAB_CI`, `CIRCLECI`, `JENKINS_URL`), the same check for named hosts, Docker auto-start and
  readiness timeouts. `src/architecture.test.ts` enforces the single reader.
- `child-env.ts` is the environment of every process started for the project (apps, `exec`,
  tasks, migrations, the seed, prisma): never the connect tokens, never the config's `unsetEnv`.
  It is module state set by `createDevEnvironment`, because every spawn point reaches here and none
  has the config. buncargo's own tools (frpc, the Infisical CLI) keep `connectProcessEnv`.
- `state-paths.ts` owns both state directories: `~/.buncargo` (machine-wide: routes, runs,
  certificates, downloaded tools) and `<root>/.buncargo` (per-checkout: port lockfile, tunnel
  registry, typecheck artifacts), plus the `sudo`-aware home resolution and chown that make the
  first one correct when the root daemon writes it. Tests relocate it by pointing `HOME` elsewhere,
  deliberately *not* through a dedicated override: a second mechanism outranking `HOME` leaks
  between test files that already isolate this way.

## Persisted files and locks

- `registry-file.ts` reads and writes the persisted state files (`routes.json`,
  `hosts-daemon.json`, `hosts-service.json`, `ports.json`, `public-tunnels.json`) through typed
  validators. Writes go via temp file + rename: the hosts daemon re-reads `routes.json` every
  second, and a truncating write would let it read the file empty and conclude there is no state.
  A read is lenient by default and `strict` for a consumer that only reads: a missing file is "no
  state yet", but an unreadable one is state we cannot see, and the daemon must fail rather than
  serve an empty world. Writers stay lenient: they can repair the file, while throwing would strand
  them behind one only a human could delete.
- `file-lock.ts` guards every shared read-modify-write using kernel flock on a persistent
  `.lock.v2` inode. Never unlink that inode or steal a live holder. Death releases the kernel lock;
  acquisition times out with an error and never executes unlocked. Bun FFI loads lazily on
  macOS/Linux; Windows users need WSL.

## Tools and startup cost

- `tool-binary.ts` resolves external binaries: env override, then `PATH`, then the download cache.
  That cache is `~/.buncargo/bin`, not `tmpdir()`, which macOS purges: a vanished `mkcert` takes
  named hosts down on the next run that has to widen the certificate. Its `lookupOnPath` scans
  `PATH` with `access` rather than shelling out to `command -v`. That is a builtin, so it looked
  free, but it is still a fork and an exec, reached for `docker`, `container` and `mkcert` before a
  run starts anything.
- `sleep.ts` is a leaf on its own rather than part of `utils.ts`, which also holds `getEnvVar` and
  therefore imports port allocation, the host plan and the network helpers. The hosts daemon needs
  nothing but `sleep`, and taking it from `utils` pulled that whole graph into the single file a
  root launchd job executes. `utils.ts` re-exports it, because `buncargo/core/utils` is a published
  entry point.
- `timing.ts` measures CLI entry through actual app readiness (or startup failure), including
  config/ports, preparation, tunnels and both waves. `--timing-json` includes numeric-only startup
  metrics. Keep diagnostics free of commands, secrets and environment values; counters are dormant
  when unobserved.

## Shared answers

- `prompt.ts` is the one prompt primitive: `askChoice`/`askConfirm`, `isInteractive`, decline
  markers, and `claimFirstRunPrompt`. That last one is why it exists: "at most one first-run setup
  question per run" cannot be enforced while each prompt owns its own gating, and a fresh machine
  can otherwise hit both named-hosts setup and the menu bar offer in one `dev`.
- `primary-app.ts` answers "which app is this project about" once, from `options.primaryApp`.
  `resolvePrimaryApp` infers from the dependency graph when nothing is configured;
  `configuredPrimaryApp` never infers and is what named hosts use.
- `service-identity.ts` decides what a service *is* from its preset rather than its name. The
  banner used `name.includes("postgres")`, so a service keyed `db` from `service.postgres()` got no
  TablePlus link while the Compose side knew the preset all along. The banner, run registry and menu
  bar app share one answer, and `tablePlusUrl` lives here.
