# Ports

A checkout's ports are the config's base ports plus its offset. Startup cost is paid on every run
in every worktree, so the questions below are answered from one snapshot per phase, not one process
per port.

## Allocation and claims

- `src/core/port-allocation.ts` hashes a project offset, probes conflicts, and persists
  `.buncargo/ports.json`. `probeConflicts: false` turns the probe off for a read: `getEnvVar`
  answers a `vite.config.ts` with the ports the environment is *using*, and cannot resolve a
  runtime without importing the backends that import it back, so probing there would read this
  project's own service container as foreign and shift the block onto a port nothing is listening
  on.
- It takes the resolved runtime for the same reason the readiness check does: asking Docker about a
  port an Apple container published reports the `container` forwarder process, which classifies as
  a foreign occupant and shifts the offset by `PORT_OFFSET_STEP`. A shifted port changes the
  generated model, which changes Apple's `buncargo.config-hash`, so every run recreated its own
  containers and alternated between two ports. A container of ours on the *other* backend must
  still shift: that port really is taken.
- `buncargo prisma` and `env.prisma` (`ensureDatabase`) start the database outside `start()`, and
  used to start it on the context's unprobed preview with no claim: a CI runner's Postgres landed on
  a port another OS user's stack published and failed the service preflight on every rerun. Claims
  are per user (`~/.buncargo`), so the container listing is what keeps users sharing one daemon
  apart. They now allocate with `prepareStartAsync` for the database, unless this environment has
  already allocated: probing again would move a live run's block under it and replace its
  selection. A run in another process is not an allocation of this environment: the prisma path
  probes, finds the run's database container is this project's and keeps the block, while a
  lockfile block another project's container now holds is set aside as `dev` sets it aside. A CI
  runner's checkout keeps its lockfile between jobs while other stacks come and go on the daemon.
  An app-only allocation never probed the database's port against containers, so that case still
  meets a foreign one at the preflight.
- `offset-claims.ts` is `~/.buncargo/offsets.json`, root → offset and the block's ports. Every
  probing allocation skips a block another existing checkout claims, by its offset or by any one of
  its ports, and every claiming one writes its own. Offsets alone missed collisions between
  configs: api 3000 at offset 1100 and admin 4000 at offset 100 are both 4100. The ports are an
  optional field, so the file keeps its version and an older buncargo still reads it. A claim
  written without them takes its ports from its checkout's lockfile (when the offsets match) until
  that checkout's next run rewrites it; holding the offset alone let a newcomer take an
  overlapping block and moved the incumbent on its next run. `doctor` and `ports` report
  overlapping claims by the same rule and the same lockfile reading. A suffixed
  environment claims without persisting a lockfile, under `offsetClaimKey(root, suffix)` with
  `root` and `suffix` stored in the claim (the key is never parsed), so it never replaces its
  checkout's dev claim.
  It was unclaimed before, and parallel CI jobs on one machine all took the same block: their
  checkouts share a directory name and so a hash, and they probed before any had bound a port.
  A developer's dev claim lives as long as its directory, which is what tells "stopped" from
  "deleted", and keeps a stopped worktree's URLs. A throwaway environment's claim (suffixed, or
  any in CI) is released when a full `stop()` has taken its stack down (`releaseThrowawayClaim`):
  self-hosted runners keep their directories between jobs, and their dev, `ci` and E2E claims
  held all 90 blocks of a machine running a few dozen runners, so every new allocation failed.
  Not on `restart()`, which needs the block back, nor while another run of the same environment
  is on record; a `start()` after the release claims again. A suffixed stack the sweep or
  `buncargo stop` removes loses its claim the same way (`releaseSuffixedClaimsOf`), unless its
  checkout was deleted. A CI dev run killed before its teardown keeps its claim until that
  directory's next job: the claim does not record that it was made in CI. Releasing a CI dev
  claim after a `dev --down` that kept volumes also drops the project-name refusal for them;
  in CI the next job of that directory claims the name again.
  The search for a free block wraps from 9000 to 100: climbing from the hash alone gave a
  checkout that hashed high only the few blocks above it. Allocation ignores a deleted
  checkout's claim, and the sweep drops it (after its volumes, on the opt-in in
  `run-registry-and-sweep.md`). A claiming allocation holds
  `offsets.json`'s lock from reading the claims to writing its own (`withFileLockSync`, because the
  allocator is synchronous), or two checkouts starting together pick the same block. The lockfile is honoured by its
  offset alone, applied to the config's current ports, so an added service or a hand-written
  `{ "offset": n }` keeps the block, and a run that sets the lockfile aside says why.
- A claim also records the checkout's Compose project name, and a claiming run refuses to start,
  under the same lock and before it writes anything, when another existing checkout's claim
  carries its name; `ports pin` refuses with the same check and message. Offsets only keep two
  checkouts apart on ports; one name is one stack, so they shared the database, and one
  parallel CI job's `ci` teardown deleted the other's volume.
  Two cases produced it: CI runners whose checkouts share a directory name, and a `dev.config.ts`
  below a worktree's top level (`example/playground`), which `getWorktreeName` does not see as a
  worktree because it reads only the root's own `.git`. Deriving the name from the enclosing
  worktree instead would rename every such checkout's stack and detach its volume, so the refusal
  is the guarantee and the fix is a `projectPrefix` that differs per checkout (the playground
  derives one from its worktree). Claims of the same checkout through another path, a deleted
  checkout's claim, `BUNCARGO_PORT_OFFSET` (checked, though it records nothing) and
  `worktreeIsolation: false` (sharing is what it asks for) do not refuse. `doctor` reports names
  two existing claims already share.
- A claim can outlive the config that wrote it: worktrees that last ran an older playground
  config held `buncargo-playground-playground`, and the main clone's playground was refused until
  each ran once or was deleted. Claims are not dropped by age, because an idle checkout's claim is
  what keeps its database to itself. `buncargo ports release --root <path>` is the one way to drop
  another checkout's claims, and the refusal names it with the holder's root. It confirms first
  (`--yes` without a terminal), refuses while that checkout has a live run or containers in the
  idle hold, and touches no container or volume: whoever runs under the name next uses its volume.

## Who holds a port

- `process/port-snapshot.ts` is one reading of every TCP listener (`lsof -Fpcn`), and
  `createPortOwnerSnapshot` in `port-owner.ts` answers "who holds this port" for many ports from
  it. A dev run asks that question in four places (the allocator, the service preflight,
  `classifyCliApps` and the spawner) and each answer used to cost an `lsof`, a container listing, a
  `ps` and a second `lsof`, so a small config forked about thirty times before the first server
  started. The snapshot is created per phase and thrown away; anything that changes ownership on
  purpose (`killPortOwner`, the takeover) takes a fresh reading. The spawner takes one **per
  wave**, because wave 2 runs after wave-1 servers have bound their ports.
- `withBindProbe` (`process/port-owner.ts`) wraps the allocator's owner lookup: a port the lookup
  reports free but that will not bind on `127.0.0.1`, `0.0.0.0` or `::` is held by something `lsof`
  cannot show this user (a root macOS service) and is foreign. Every address is tried because they
  do not block each other. It binds only ports the lookup found nobody on, so ours are never
  touched.
- A port held by the *other* backend is invisible to the selected one, so the diagnostic degraded
  to the daemon that owns the socket: switching a project to Apple with a Docker container still up
  reported `com.docker.backend` rather than the container's own name. `getPortOwner`'s
  `fallbackRuntimes` asks the other runtimes only after the selected one comes back empty, and only
  from `assertServicePortsClaimable` and `doctor`, the two places that report the failure.
  `killPortOwner` polls ten times a second and deliberately does not pay for it. The adapters are
  passed in rather than resolved in `core/`, which would make `core/process` import the runtimes
  that import it back.
- `PortContainerOwner.runtime` is what stops a cross-runtime container being classified `reuse`: it
  carries this project's own name, but this run cannot start, exec into or tear it down through the
  backend it selected. `formatPortOwner` names the backend only when it differs from the selected
  one, and does so *after* the noun: `containerRuntimeDisplayName` is a product name, so "Apple
  container" cannot qualify "container".
- Tailscale mode's HTTPS ports (`companionPorts`, [named hosts](./named-hosts.md#tailscale-mode))
  are part of the block's claim but never probed: Tailscale binds them on the tailnet address,
  which fails the bind probe for the checkout's own entry.
- An app's `extraPorts` (`extraPortMap`) are claimed *and* probed, keyed `<app>#<n>` so a
  selection that names the app probes them and one that does not leaves them alone. They are not in
  the port map, so they never reach the env or the lockfile: the lockfile's offset brings them back.
- An integration stack's containers are recognized as this run's by their Compose project label;
  see [integrations](./integrations.md#stacks).
