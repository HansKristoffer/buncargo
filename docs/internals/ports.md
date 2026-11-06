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
  checkout was deleted; `stop` releases nothing when it removed nothing (an app-only run) or
  another entry of the project still holds containers, whose stack the claim may be. Every release decided from an earlier read is compare-and-set
  (`releaseOffsetClaimsIfUnchanged`, by the fields `markOffsetClaimsReclaimed` compares), and a
  stack's teardown releases only claims last used before its run started: a job allocates before
  it publishes its run, and the last job's stack coming down in that window took the new job's
  claim with it. A stack the sweep downs with no run on record has no start to compare with, so
  it keeps a claim used within `RECLAIM_MIN_IDLE_MS` (the hour a full range also spares). A CI dev run killed before its teardown keeps its claim until that
  directory's next job: the claim does not record that it was made in CI. Releasing a CI dev
  claim after a `dev --down` that kept volumes also drops the project-name refusal for them;
  in CI the next job of that directory claims the name again.
  The hash spreads checkouts over 100 to 9000, and stays there: widening it would move every
  checkout without a lockfile. The search for a free block climbs from the hash to
  `maxPortOffset`, the highest offset that keeps the config's highest port below 32768 (Linux's
  ephemeral range, where outgoing connections take ports at random; macOS's starts higher),
  never below 9000, then wraps to 100: climbing from the hash alone gave a checkout that hashed
  high only the few blocks above it, and 90 blocks were full on a machine with 80 claims of
  which two were running. Allocation ignores a deleted
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
  each ran once or was deleted. `buncargo ports release --root <path>` drops one checkout's
  claims, and the refusal names it with the holder's root. It confirms first (`--yes` without a
  terminal), refuses while that checkout has a live run or containers in the idle hold, and
  touches no container or volume: whoever runs under the name next uses its volume.
- Claims are not dropped by age on a timer, because an idle checkout's claim is what keeps its
  ports and URLs. Their blocks are taken back when the range is full: a claiming allocation that
  finds every block taken throws `PortBlockExhaustedError` with what blocks each offset, and
  `prepareStartAsync` (`allocateReclaiming`, so `dev`, `start()`, `ci` and the prisma path)
  reads which holders are idle, marks the claims of the block whose holders were all started
  least recently `reclaimedAt`, logs whose, and allocates again. Idle means no live run and no
  finished run with services on record for the checkout, no running container of the claim's
  project (a runtime that is up and fails to list makes every claim unreadable, not idle), and
  not used in the last hour: a start allocates before it records its run, and the named-hosts
  prompt or `buncargo prisma`, which records none, sits in between. All of it is paid only on a
  full range. A block a process holds is probed then and never reclaimed, since freeing its
  claim would not free it.
- A reclaimed claim is marked, not deleted. It holds no block (`claimsWithLockfilePorts`, and so
  allocation, `pin`, `ports` and `doctor`'s overlaps, skip it) but stays for everything else:
  the project-name refusal, `prune`'s existing checkouts, the orphan report and the sweep's
  `isKnownStack`. Deleting it made an idle checkout's database look like an orphan to `prune`,
  freed its project name for another checkout to run on its volume, and made its exited
  containers foreign to the sweep. The checkout's next claiming run rewrites the claim without
  the mark, on a new block once its lockfile's block is another checkout's. Until then a read in
  it sets the lockfile aside when its own claim holds no block and another claim covers the
  lockfile's block; a live run always holds its claim, so a pre-lock overlap still reads as the
  run serving it does. Marking compares each claim's offset, name, `updatedAt` and `usedAt`
  with what the scan read, under the claims lock, so a run that started in between keeps its
  block; that is why `claimOffset` rewrites `usedAt` on every claiming run (one file write, no
  fork). Not the whole claim: a reader fills a port-less claim's ports from its lockfile, and
  the oldest claims, the ones a full range reaches first, are port-less. The synchronous
  `prepareStart` does not reclaim: it has no liveness to read. `ports release --idle` marks the
  same idle claims by age on request; `ports release --root` still deletes, since freeing the
  name is its purpose. None touches a deleted checkout's claim, a container or a volume.
- A read (`claim: false`) never throws on a full range: a checkout with no lockfile gets the
  hashed block with provenance `unallocated`. `status`, `env`, `url` and `ports` are what an agent
  reaches for in exactly that state, and every one of them failed with the allocation error, so
  agents started their own databases and hand-wrote lockfiles. Those ports are another checkout's,
  so `exec` (the environment's, which the CLI and tasks use) refuses on an unallocated plan.

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
- A stack is **stale** when its `buncargo.root` label is this checkout and its project name does
  not start with `<projectPrefix>-<directory>` (`staleStackProject`). Renaming `projectPrefix`
  renames every stack of the checkout, and the old one kept publishing the ports the new name was
  given: "held by container bliss-…" in a checkout now called budget-app, with no hint that the
  holder was its own. Every name the checkout runs under now, dev, `ci`, any suffix and worktree
  suffix included, starts with that base, so a suffixed environment's stack is never stale. The
  rule assumes one config per checkout root: a second config with another prefix at the same root
  reads as stale to the first. Compose's `com.docker.compose.project.working_dir` is not read: an
  integration's stack or the user's own Compose file run from the checkout carries it too.
- `formatPortOwner` names a stale stack, for callers that pass the checkout (the allocator's
  conflict message, the service preflight, `doctor`), with `manualComposeDownCommand` on Docker.
  Apple's CLI removes containers by id, and the message knows only the one on the port, so there
  it names `dev --replace-stale` alone. `ports pin` and the backends' `up` collision messages do
  not pass the checkout.
- `dev --replace-stale` (`start()`'s `replaceStaleStacks`) runs before allocation, because the
  allocator would otherwise move the block off the stale stack's ports. It removes only stale
  stacks holding a port of the block the run would take, through the adapter's `down` (volumes
  kept), and under the project's lifecycle lock it first checks again that every container of the
  project carries this root and that no live run, from any checkout, uses the name: `down` acts
  on the name alone, and `worktreeIsolation: false` shares one name across checkouts.
- An integration stack's containers are recognized as this run's by their Compose project label;
  see [integrations](./integrations.md#stacks).
