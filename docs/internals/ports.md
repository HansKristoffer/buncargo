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
- `offset-claims.ts` is `~/.buncargo/offsets.json`, root → offset. Every probing allocation skips
  another existing checkout's offset; only a persisting one writes its own. A claim lives as long
  as its directory, which is what tells "stopped" from "deleted". The lockfile is honoured by its
  offset alone, applied to the config's current ports, so an added service or a hand-written
  `{ "offset": n }` keeps the block, and a run that sets the lockfile aside says why.

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
- An integration stack's containers are recognized as this run's by their Compose project label;
  see [integrations](./integrations.md#stacks).
