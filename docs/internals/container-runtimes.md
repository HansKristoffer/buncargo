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
  `config.docker.runtime`, then `"docker"`. An explicit choice is returned even when its daemon is
  down, so the failure surfaces as that runtime's own remediation instead of a silent switch to the
  other one. The two keep their volumes in different places. For the same reason `"auto"` asks
  whether Apple is *installed*, not whether it is running: its system service is down after every
  reboot until something starts it, and a running-check sent those runs to Docker's empty volumes.
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
  through the adapter. `pg_isready` / `redis-cli` go through `adapter.execInService`; `http` hits
  the published host port. `tcp` does too unless the adapter has `probeServicePort`: Apple's port
  forwarder accepts a connection on the published port whether or not anything listens inside, and
  holds it open, so a host-side connect passed the moment the VM booted. Apple answers from the
  container's own address instead. `http` needs no such help, since the forwarder resets the
  connection once the request is written.
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

It serves two runtime names. `"docker"` talks to whatever engine Docker's current context points
at; `"orbstack"` is the same backend with `--host unix://~/.orbstack/run/docker.sock` on every
command (`DockerBinary` in `binary.ts`), so a project stays on OrbStack whichever context the
machine has selected.

- OrbStack is a runtime name rather than a context setting because the name is what a run records
  in `runs.json`, and the sweep, `stop` and `ls` tear down and list through the recorded runtime
  with no config in scope. Recorded as `"docker"`, an OrbStack stack would be looked for on Docker
  Desktop and leak.
- On disk it is written as `runtime: "docker"` plus `engine: "orbstack"` (`encodeRun` in
  `run-registry.ts`). Every buncargo version on the machine shares `runs.json`, and older ones
  validate `runtime` against the names they know: one dropped a live OrbStack run the next time its
  watchdog rewrote the file. They keep unknown fields, so `engine` survives. A new runtime name
  needs the same treatment.
- When Docker's context *is* OrbStack, both runtimes reach one engine and list the same
  containers. `uniqueContainers` keeps the first listing; ownership matches on project and root,
  never runtime, so the duplicate could only cost a second, empty teardown.
- The OrbStack candidate is gated on its socket file existing: the sweep asks every runtime every
  30s, and a spawn there on every machine without OrbStack is waste.
- `--host` rather than `DOCKER_HOST` because `interactiveExecArgv` hands argv to a caller that
  spawns it with its own environment.
- `runtimeFromContext` trusts a context that names its engine (`desktop-linux`, `orbstack`) before
  any installed app. Checking `/Applications/OrbStack.app` first made a machine with OrbStack
  installed and Docker Desktop selected start OrbStack, then wait for a socket that never came up.
- The Supabase CLI follows Docker's context, not ours, so the Supabase check refuses a pinned
  `"orbstack"` the way it refuses Apple, instead of splitting the project across two engines.

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
- Compose's list forms of `labels` and `environment` are normalized like the map forms. The list
  form of `labels` is the one a typed config can write, and it carries buncargo's own labels too:
  dropping it left a container that `down`, `ls` and the sweep could not find by project.
- Container names are capped at 63 characters, the most Apple accepts, ending in a hash of the full
  name. Volume names are not: Apple takes them longer, and renaming one would hide its data.
- `container_name` is in the *warned* set, not the translated one. The container is always
  `<project>-<service>` so exec, reuse and teardown agree on one name; honoring a user-set value
  would mean threading a second name through all three, for a key buncargo's own presets never
  emit.
- Each container carries a `buncargo.config-hash` label, so `up` can tell "mine and still matching"
  (start it) from "config changed underneath it" (recreate) rather than throwing away a warm data
  volume on every run.
- New named volumes are created at 256G. Apple formats each as a sparse ext4 image, and formatting
  its 512G default took about a second against ~0.4s, paid by every new checkout's database. The
  CLI cannot grow one later.
- The apiserver serializes VM creation and volume formatting: three `run`s in parallel took as long
  as in sequence. Do not parallelize `up` for speed.
- A verbose `up` pulls a missing image itself, streamed, before `run`: inside `run` the pull is
  captured and silent for minutes. The pull names the platform, because `image pull` without one
  fetches every platform the image publishes.
- Recreating a running container stops it before `delete --force`, which kills. `run` is retried
  once when Apple reports the container it is creating as not found, a transient seen after a
  delete of the same name.
- `cli.ts` is the only place the binary is executed, and is injectable so `lifecycle.ts` and
  `status.ts` are tested without the runtime installed.
- `status.ts` reads `container ls --all --format json` once and filters client-side: Apple's `ls`
  has no `--filter`. Its JSON shape has moved between releases, so each field is read defensively
  rather than against a fixed schema.
- `preflight.ts` auto-starts via `container system start` but never passes
  `--enable-kernel-install`: with it, a first run would install a kernel without asking; without
  it, the command prompts and would hang a non-interactive spawn.
