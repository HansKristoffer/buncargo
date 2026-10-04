# Named hosts

`src/core/hosts/` is named `.localhost` HTTPS: hostname planning, the user-level
`~/.buncargo/routes.json`, mkcert, the loopback proxy daemon, `/etc/hosts` sync, and first-run
onboarding. Hosts reliability is a top priority: the failure mode is silent, a run falling back to
`localhost:port` with no error. `worktree-soak.test.ts` (opt-in) exists to catch it.

## Daemon and client

- `daemon.ts` is the server (what `hostsd.js` bundles); `daemon-client.ts` is the CLI side (health
  readers, `waitForDaemonRoutes`, `ensureHostsDaemonRunning`) and `daemon-config.ts` is the
  port/pidfile state both share. The direction is one-way: the daemon must never import the client,
  which reaches for the service manifest and the container runtimes to name a `:443` squatter.
  That split, plus the `sleep` leaf, keeps `dist/hostsd.js` small; `src/architecture.test.ts`
  enforces it.
- `daemon-bundle.ts` owns the one file the service executes: `dist/hostsd.js`, bundled from
  `src/cli/hostsd.ts` and installed to `/usr/local/libexec/buncargo/hostsd-<version>.js`. The
  service cannot run `dist/cli/bin.js`: it is code-split across sibling chunks, it disappears when
  a project reinstalls dependencies, and macOS denies a root daemon any path under `~/Documents`,
  so launchd cannot even read it. Installing a single root-owned file answers all three and stops
  root executing a user-writable file.
- The daemon runs as root under launchd/systemd, which give it a minimal `PATH` and no `HOME`.
  `privilegedDaemonEnv` injects `HOME` and `SUDO_*` so it reads the installing user's `~/.buncargo`
  and chowns what it writes back to them.
- The daemon spawns nothing. `certificates.ts` mints the leaf in the CLI, where `mkcert` resolves
  the way it does interactively; the daemon polls `certificateFingerprint()`, rebinds when the CLI
  reminted underneath it, and reports `describeCertificateGap()` rather than shelling out as root.
- `ensureHostsDaemonRunning` never starts a daemon itself. A user-level one could not bind `:443`
  beside the service, and now that the listener sets `SO_REUSEPORT` it would bind *successfully*
  and the two would answer from separate route maps at random. `runHostsDaemon` refuses to start
  when another live pid is already answering, on the foreground path only; under `KeepAlive` an
  exit there would just be respawned.

## Service install

- `service-files.ts` builds the launchd plist / systemd unit (pure); `privileged.ts` is the one
  `sudo` seam, injectable so `service.ts` can be tested without a password prompt; `service.ts`
  installs, removes and validates the service.
- Installs are all-or-nothing: a unit file left behind by a failed load would make
  `isHostsServiceInstalled()` report success and every later run would skip setup. On failure
  `service.ts` removes the file it wrote.
- `hosts-service.json` records what the service was installed with. The bundle path carries the
  version it was built from, so `describeStaleHostsService()` catches both a vanished path and an
  upgraded CLI still pointing at the previous bundle, instead of silently degrading to
  `localhost:port`. It also records the bundle's content hash, because the path stops at the
  version: a rebuild during development passes every path comparison while running code that no
  longer matches the CLI. Either side being unknown means "cannot compare", never "stale".

## Certificates

- `cert-names.ts` remembers which certificate names each repo root wants. The leaf used to be
  minted from the live route registry alone, so a project stopping dropped its names and starting
  it again reminted, and a remint rebinds the listener, dropping every proxied websocket on the
  machine, including other projects' HMR sockets. Entries are retired when their checkout is gone
  from disk, the only signal that separates "not running" from "no longer exists".
- `certificateHostnames` adds `*.<hostname>` and one wildcard per ancestor down to one label above
  the TLD, so a new worktree of a known project needs no remint at all. A wildcard covers exactly
  one label, which is why both directions are needed. Never `*.<tld>`: browsers reject it and it
  would let any project serve any other's name. `certificateCovers` applies the same one-label
  rule, so `certNeedsRenewal` does not report a gap for a name a wildcard already serves.
- Minting and reading the pair both go through `withFileLock` on the cert path, and `mintCert`
  renames the two files in (key first, cert last) instead of letting `mkcert` write them in place.
  Landing a pair is two steps whichever way it is done, so an unlocked daemon can bind a new
  certificate against the previous key and take every named URL down until the next reload.

## Activating a run's hosts

- `cli/dev-hosts.ts` mints for the plan's hostnames *before* publishing them to the registry, via
  `syncCertificateForRoutes({ include })`. Published first, a hostname is one the daemon's next
  poll tries to serve with a certificate that omits it.
- `syncCertificateForRoutes` runs a **second** time in `activateNamedHosts`, after the routes are
  published. The first pass reads the registry before publishing, so a run that minted in that gap
  produced a certificate covering itself and not us. The second pass runs under the same lock, sees
  every concurrent run's routes, and mints nothing when the certificate is already sufficient.
- `activateNamedHosts` returns its warnings rather than printing them: a run that goes on to take
  over another one activates twice, and the first failure (the other run still owning the
  hostnames) is one the second attempt undoes, so printing it would have the banner contradict it
  three lines later.
- `upsertHostRoutes` answers a second `buncargo dev` in the same checkout, pointing at the same
  port, with `keep` rather than a conflict: it is reusing the servers the first run started, not
  competing for the hostname. The live owner stays the owner, because `releaseNamedHosts` filters
  by pid and the route has to disappear when the run owning the servers exits. Refusing instead
  left that run printing `localhost:port` while the named URLs worked.
- `prune` drops a static (pid-less) route whose `root` no longer exists. Nothing else retires one,
  so a deleted worktree kept its hostnames in the registry, and in `/etc/hosts`, forever.
- `syncHostsFile` writes through a temp file and a rename. `writeFileSync` truncates in place, and
  every name resolution on the machine reads this file, including the `localhost` entry the
  system itself depends on.
- `primary-app.ts`: named hosts use `configuredPrimaryApp`, which never infers, because inferring
  an owner for the bare `myapp.localhost` would silently move a name people have bookmarked.

## Reloading

- Only a reminted certificate rebinds the listener. `lookup` reads the live route map, so a route
  change needs no restart, and restarting on one would drop every proxied websocket each time an
  app registers or expires. That rule lives in `createHostsReloader`, which takes every edge
  (routes, fingerprint, proxy, `/etc/hosts`, clock, exit) as an injected dependency so it can be
  tested without binding a port; `runHostsDaemon` is only the composition that supplies the real
  ones.
- `runHostsDaemon` never lets a `reload()` throw escape: `KeepAlive` would respawn it forever.
  Failures go to `/var/log/buncargo-hosts.log` and retry on a widening backoff.
- A rebind binds the replacement **before** stopping the old listener, under `SO_REUSEPORT`.
  Stopping first left a window where nothing answered `:443`, and a CLI health probe landing in it
  reported the daemon as down, which the remint for a new worktree's hostnames makes likely. A
  failed bind therefore leaves the previous listener serving and `lastCertKey` unadvanced, so the
  next reload retries.
- `watchHostsState` reloads on a filesystem event instead of waiting for the next poll, which is
  0-1000ms of pure waiting on every run in every worktree. It watches the *directories*, because
  writes land through a temp file and a rename, so a file watch would hold an inode that never
  comes back. The 1s poll stays as the backstop (it also prunes routes whose owner died, which no
  event announces), and `MAX_RELOAD_BACKOFF_MS` is 5s, because a reload is a file read and a longer
  ceiling delayed every other project's routes over one project's problem.

## Health

- `isProxyHealthy` probes the one scheme `readDaemonConfig().tls` says the daemon serves and
  validates the health body, not just the status. `ensureHostsDaemonRunning` returns early when
  health passes and never reaches the squatter check, so accepting any 200 on `:443` would hand the
  whole flow to whatever else is listening. Do **not** gate it on `routes > 0`: the daemon binds
  before any route exists, and a fresh machine would report itself down and fall through to the
  squatter path.
- The listener and the reload loop fail independently, so health alone proves nothing about
  routing: a loop that stops leaves `Bun.serve` answering 200 while every named URL 404s against a
  frozen map. `lastReloadAt` travels in the health body, the proxy notices a stale map **from the
  request path** (a timer-based watchdog would die with the timers it watches), and the daemon
  reloads in-band before falling back to `process.exit(1)` for `KeepAlive` to restart.
- On the CLI side `waitForDaemonRoutes` is what stands between the registry and the banner: a route
  is a file until the daemon picks it up, and advertising it earlier is how https URLs come to
  point at our own 404. It retries a probe that does not answer rather than failing on it (the
  rebind window above), and still distinguishes the two outcomes: a daemon that never answered
  needs a restart; one that answered without the hostname has a registry it is not picking up. A
  daemon that reports no `hostnames` is unverifiable, not failing.

## Proxy

- `proxy.ts` repeats the client's `sec-websocket-protocol` to the upstream and back. Vite only
  adopts an upgrade whose protocol is `vite-hmr`; strip it and the socket stays in Vite's HTTP
  server with no `error` listener, so the next reset kills the dev server with an unhandled
  `ECONNRESET`. For the same reason `stop()` closes bridged upstreams before the forced server stop,
  and an upgrade Bun refuses gets a 400 rather than being forwarded over `fetch`, which cannot
  finish a handshake.
- Both `Bun.serve` calls in `startLocalProxy` set `idleTimeout: 0`. A proxy has no say in how often
  its upstream speaks, and Bun's 10s default counts a quiet streamed response as idle, so it resets
  SSE, oRPC Event Iterators and idle HMR sockets mid-body; the browser reports that as
  `ERR_INCOMPLETE_CHUNKED_ENCODING` on a request that already returned 200. Anything that
  keep-alives less often than 10s (oRPC defaults to 15s, tuned for hosted proxies) dies before its
  first ping. Do not answer this by shortening the app's keep-alive; the proxy is what is wrong.
