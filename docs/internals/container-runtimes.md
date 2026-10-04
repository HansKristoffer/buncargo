# Container runtimes

Three layers, kept apart:

- `src/docker-compose/` generates the Compose artifact (model building, YAML serialization,
  generated-file logic) and the built-in presets in `services/`. No runtime calls.
- `src/container-runtime/` is the runtime-neutral seam and the canonical import for everything
  outside the two backends.
- `src/docker/` and `src/apple-container/` are the backends.

The sweep and volume pruning live in `container-runtime/` too; see
[run registry and sweep](./run-registry-and-sweep.md).

## Compose generation

- `interpolate.ts` is Compose's own `${VAR}` substitution and the fingerprints built on it. It
  lives here rather than with one backend because it is Compose semantics: `docker compose`
  interpolates the file itself and the Apple backend has to reproduce it, so a second copy would be
  a second thing to keep in step. `apple-container/run-plan.ts` re-exports it.
- `computeDevIdentity` leaves the worktree name out of the project name when the directory already
  carries it.
- `serviceFingerprint` and `buncargo.service-hash` govern reuse per service, independent of
  selected subsets. Include effective interpolation, user labels and referenced definitions;
  exclude only self-referential hash metadata. Unverifiable external inputs must reconcile.
- `buildComposeModel` takes the *resolved* `ContainerRuntimeName`, not the configured selection,
  because `docker.runtime` may still say `"auto"` at that point. It exists for the few places the
  runtimes genuinely differ: the postgres preset sets `PGDATA` to a subdirectory on Apple, whose
  named volumes are formatted block devices carrying a `lost+found` that `initdb` refuses. Docker's
  are plain directories, and moving them would hide every existing project's database behind an
  empty one. A preset that branches on this for anything cosmetic is not worth the ambiguity it
  adds to the generated model.

## The seam

- `types.ts` is the `ContainerRuntimeAdapter` port. `ContainerUpRequest` carries both
  `composeFile` and `model` because they are one artifact seen two ways: Docker hands the file to
  `docker compose`, Apple walks the model. Deriving the model separately per backend would let the
  two drift.
- `resolve.ts` is the precedence: `--runtime`, then `BUNCARGO_CONTAINER_RUNTIME`, then
  `config.docker.runtime`, then `"docker"`. Only `"auto"` probes; an explicit choice is returned
  even when its daemon is down, so the failure surfaces as that runtime's own remediation instead
  of a silent switch to the other one. The two keep their volumes in different places.
- There is one `binary` override for two backends, so it only means anything once a runtime is
  chosen: `resolveContainerRuntimeBinary` returns nothing under `"auto"`, config validation rejects
  the pairing outright, and `availableContainerRuntimes` applies the path only to the runtime named
  alongside it. Otherwise probing for Apple's `container` would mean executing whatever `docker`
  was pinned to, and reporting the wrong one down.
- `containerRuntimeForEnv()` is how a caller holding a finished `DevEnvironment` rebuilds its
  adapter. The runtime name and the resolved binary have to travel together; going through the name
  alone would silently drop a configured `docker.binary` in `status`, `doctor` and prisma.
- `ExecInServiceRequest.command` is argv, not a shell command line, so neither backend has to quote
  it and the two cannot disagree about which shell runs a probe. Both backends spawn argv
  throughout; the only surviving shell is `command -v` in `src/docker/preflight.ts`, a builtin with
  nothing to exec.
- `inventory.ts` backs the machine-wide commands (`ls`, `doctor`, `dev --down --all`). Those have no
  project config in scope, so they ask every available runtime rather than one.

## Readiness and reuse

- `readiness.ts` and `health-checks.ts` are the polling loop and the built-in probes, both driven
  through the adapter. `pg_isready` / `redis-cli` go through `adapter.execInService`; `http` /
  `tcp` hit the published host port and are runtime-independent by construction.
- `diagnoseService` is why a dead container fails in about two seconds instead of after the full
  readiness timeout. `readiness.ts` calls it every eighth poll, and only a state in
  `isTerminalContainerState` aborts, matched positively so a state neither backend has shown us yet
  keeps polling rather than killing a startup that would have worked. `logTail` is enrichment: a
  backend that cannot produce it returns empty and the state alone still fails fast.
- `ensureServicesRunning` skips `up` only when each selected service is running with a matching
  service fingerprint and every relevant input can be proven unchanged. Old unlabeled containers
  reconcile once. Every adapter operation that talks to the daemon is async and cancellable; the
  sync methods that remain (`list`, `stopByIds`, the port lookups) back the snapshot readers.
- `projectServiceStates(projectName)` reads state and the stack hash for the whole project in one
  call. `areServicesRunning` asked separately per service, so a four-service stack paid four
  `docker ps` listings before anything started. `containerPortOwners()` is the batch form of
  `findContainerOnPort` for the same reason: a dev run asks about every service and app port, and
  one listing answers all of them.

## Docker backend

- Split by concern: `status.ts` (container and daemon checks), `lifecycle.ts` (up/down/start),
  `compose-command.ts` (`docker compose` argument building), `inventory.ts` (`docker ps`
  listing), `port-lookup.ts` (published-port owner). `adapter.ts` is a factory binding them to the
  port, taking the same `{ binary }` as Apple's.
- `binary.ts` is the one place the `docker` command name is spelled. Every command builder goes
  through it, so `docker.binary` reaches all of them rather than only the ones somebody
  remembered.
- `exec.ts` resolves the running service by Compose project/service/replica labels and probes it
  with direct `docker exec`. Do not use `docker compose exec` for readiness: Compose startup can
  exceed the two-second probe budget even when Postgres is healthy, making a new worktree time out
  until the next invocation skips probing via container health. Lookup and exec share one deadline;
  never cache the container ID across polls or guess it from a name.
- `preflight.ts` detects the local Docker runtime and auto-starts it when possible.

## Apple container backend

For macOS 26+ on Apple silicon. Apple has said Docker CLI/compose compatibility is not a project
goal, so this translates the generated model into per-container commands instead of swapping a
command prefix.

- `run-plan.ts` is a **pure** `ComposeDocument` → argv translation, which is why it carries most of
  the tests. It also does Compose's `${VAR:-default}` substitution itself: the model writes port
  bindings as `${POSTGRES_PORT:-5432}` on the assumption that `docker compose` interpolates the
  file, and Apple's CLI does not. `interpolate` matches every form in one pass, which is what makes
  `$$` an escape rather than a `$` a second pass could re-read.
- `interpolate` keeps Compose's colon distinction: `${VAR:-d}` replaces an empty value, `${VAR-d}`
  keeps it, and `${VAR:?msg}` / `${VAR?msg}` fail with the author's message. Collapsing the two
  would substitute a default over a variable somebody deliberately set to empty.
- `SILENTLY_DROPPED_KEYS` is `healthcheck`, `depends_on` and `restart`: the three the preset
  builders emit on every service. Warning on those would fire on every run and teach people to
  ignore the warning that matters. Everything else a user hand-wrote is reported.
- `--entrypoint` takes one command, so Compose's list form splits: head to the flag, tail ahead of
  `command` in the container's arguments. Joining the list would ask Apple to exec a binary
  literally named `/bin/sh -c`.
- `command` and `entrypoint` both go through `commandWords`, because Compose splits their string
  form into words. Passing the string through whole hands the image one long argument: the
  typesense preset writes `command` as a string, and unsplit it printed its usage and exited
  instead of starting. The split is `splitCommandLine`, which honors quotes and backslashes;
  splitting on whitespace alone turns `sh -c "echo hi"` into four broken tokens.
- `container_name` is in the *warned* set, not the translated one. The container is always
  `<project>-<service>` so exec, reuse and teardown agree on one name; honoring a user-set value
  would mean threading a second name through all three, for a key buncargo's own presets never
  emit.
- Each container carries a `buncargo.config-hash` label, so `up` can tell "mine and still matching"
  (start it) from "config changed underneath it" (recreate) rather than throwing away a warm data
  volume on every run.
- `cli.ts` is the only place the binary is executed, and is injectable so `lifecycle.ts` and
  `status.ts` are tested without the runtime installed.
- `status.ts` reads `container ls --all --format json` once and filters client-side: Apple's `ls`
  has no `--filter`. Its JSON shape has moved between releases, so each field is read defensively
  rather than against a fixed schema.
- `preflight.ts` auto-starts via `container system start` but never passes
  `--enable-kernel-install`: with it, a first run would install a kernel without asking; without
  it, the command prompts and would hang a non-interactive spawn.
