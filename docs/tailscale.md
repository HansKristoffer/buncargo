# Tailscale sharing

Buncargo discovers environments through Tailscale's peer list. Each publishing machine exposes a small private directory containing projects, branches, worktrees and service addresses. There is no hosted directory or separate Buncargo account/token system.

## Existing computers and servers

1. Install and sign in to Tailscale. Publishers require **1.102.3 or newer**; receiving computers can use their existing supported Tailscale app.
2. Enable MagicDNS and HTTPS in the tailnet admin console. Allow the publishing user to configure Serve (on Linux, an administrator can grant that user Tailscale operator access).
3. Allow the receiving computers to reach TCP **48443** (discovery) and **20000–29999** (service allocation) on publishers in the tailnet policy.
4. Install the receiving menu bar with `bunx buncargo bar install`. Its installer saves a standalone discovery command, so a global CLI installation or a local dev run is not required. Run `bunx buncargo dev` on the publishing machine. BuncargoBar discovers reachable environments automatically. `bunx buncargo tailnet status` provides the same discovery from a terminal.

An installed but disconnected Tailscale app is not enough. Buncargo reports missing sign-in, an outdated publisher, or missing Serve permissions; it never changes an existing connected machine's account.

## Cursor and other disposable Linux agents

Create a reusable, ephemeral auth key, tagged for the access policy you want cloud agents to have. Store it as the **runtime secret** `TS_AUTHKEY` in the cloud environment. Then run:

```sh
bunx buncargo dev
```

When no connected Tailscale installation is available, Buncargo downloads the pinned official Linux x64/arm64 binaries, verifies their SHA-256 checksums and versions, and caches them under `~/.buncargo/bin`. It starts `tailscaled` with userspace networking, an in-memory state and a private Unix control socket. No TUN device, root access, package manager, systemd or interactive sign-in is needed.

The same reusable key can enroll simultaneous agents. Each sandbox has independent runtime state and a unique hostname. Multiple worktrees sharing a sandbox/home share one coordinator and node. Never authenticate while building a shared environment snapshot: only binaries belong in the image. Authenticated state must not be copied between agents.

The auth key is passed to `tailscale up` through a private temporary file, removed immediately after login. It is excluded from child environments, command-line arguments, discovery and logs. A stdin guard terminates the managed userspace node even if the coordinator is killed abruptly. Existing system Tailscale installations are never stopped or logged out by Buncargo.

Enrollment keys expire after at most 90 days. Replace the runtime secret before expiry so newly created agents can join. Expiry does not itself revoke previously enrolled nodes. Tailnet policy, device approval and Tailnet Lock settings still apply; configure them for unattended enrollment as appropriate.

## Services and topbar

All selected apps and services with host ports are shared. Workers, jobs and portless containers are omitted. Apps default to HTTP; Postgres and Redis use TCP, other built-in web presets use HTTP, and custom services default to TCP. `exposeProtocol` can override the protocol. The deprecated `expose` property only controls public Cloudflare tunnels.

Browser targets open `https://machine.tailnet.ts.net:port/` directly. Ports are allocated from the worktree path and target name, so restarting a worktree keeps its address while the machine identity and available ports remain the same. Database clients connect to the same machine and the displayed TCP port. Database credentials are not published; enter them in your client. PostgreSQL rows offer TablePlus. The menu reuses the local environment and target row components, grouped by project with branch/worktree and machine names.

Use same-origin API paths through the dev server's proxy where possible. Absolute `localhost` API URLs in browser JavaScript still address the receiving computer. Buncargo does not rewrite bundles, OAuth callbacks or cookie settings. Apps on different ports of one hostname must namespace cookies; the existing Buncargo development cookie helpers support that. Expo/Metro endpoints are forwarded, but device discovery and native app configuration still depend on the consuming app.

Tailscale Serve handles HTTPS, streaming responses and WebSocket upgrades. Buncargo does not buffer HTTP bodies or replay interrupted database streams. Direct UDP, peer relay and DERP paths have different performance; joining Tailscale alone does not guarantee direct connectivity or fix a constrained relay.

## Ownership and lifecycle

- `cli/dev-tailnet.ts` activates sharing only for normal dev runs with an installed Tailscale binary or `TS_AUTHKEY`. Download/login happens asynchronously after the run is published, without delaying app startup.
- `bundle.ts` installs the same standalone discovery/publisher command for the menu and CLI. `launcher.ts` uses the self-contained `dist/tailnetd.js` bundle outside package caches and serializes startup. The coordinator holds a kernel file lock for its lifetime; all worktrees on a machine reuse it.
- `daemon.ts` reads the existing run registry every two seconds. It stops forwarding retired targets, clears stale directory snapshots on errors, and exits after one minute without live runs. A new dev run starts it again.
- `publisher.ts` derives targets once per refresh and uses a byte-stream gate for each target: loopback TCP on macOS, private Unix sockets on Linux. The Mac app's sandboxed network extension rejects Unix connections, even when Serve accepts the configuration. It checks run/app process birth identity when accepting streams. Retirement disables the gate and closes its streams, ends the Serve session, then releases the listener. Closing a gate is idempotent.
- `mappings.ts` starts foreground Serve sessions and verifies the exact hostname, port, protocol and backend before advertising a target. Existing targets reserve their ports before new targets are allocated. Cleanup closes only Buncargo's own CLI sessions; it never resets Serve or turns off another owner's route. A parent-pipe guard terminates those sessions if the coordinator dies, so Tailscale removes their routes without requiring a future Buncargo run. The same guard owns managed userspace nodes.
- `discovery.ts` probes only authenticated Tailscale peers with bounded concurrency, body sizes and deadlines. It rejects stale metadata, redirects, wrong machine identity and target URLs pointing anywhere other than the expected peer. No executable path or secret is accepted from a remote directory.

Coordinator identity and readiness live in `tailnet-coordinator.json` in the normal machine state directory. Serve ownership is temporary and is not written to a second registry. A different Buncargo build does not replace a live coordinator underneath other worktrees: stop its dev sessions and allow the idle coordinator to exit before starting the new build.

## Verification and releases

Ordinary tests cover discovery validation, ownership conflicts, session recovery, TCP half-close, streaming, selected targets and menu actions. The Linux integration suite installs the real pinned binaries and starts a userspace daemon without a TUN device or an account. Live tailnet acceptance additionally requires an enrollment key and actual cloud sandbox: verify two simultaneous agents, private HTTP/SSE/WebSocket, Postgres/Redis, one worktree stopping while another remains live, and a denied peer. Measure throughput on that actual route before comparing it with other transports.

Implementation verification (2026-09-09):

- Bun: 1,028 tests passed, nine optional integration tests skipped; lint, build and packed-package verification passed, including the standalone menu discovery command. Regression tests cover port reservation during recovery, restored mappings, stale coordinator readiness, guarded child shutdown after SIGKILL, and idempotent gate cleanup.
- macOS: six Swift tests, the ARM64 release build and menu bar smoke test passed.
- Earlier Linux bootstrap verification: 17 tailnet tests passed on the Hetzner server, including the real pinned userspace daemon. A separate run as the unprivileged `nobody` user reached the login state without a TUN device.
- A real Vite 6.4.2 server delivered file-change HMR updates through two different proxy origins simultaneously.

Authenticated Cursor enrollment and cloud-agent throughput remain unverified: these checks require a real enrollment key and cloud agent. Cross-machine Mac service access is verified below.

### Live Mac mini test (2026-09-09)

Tested the packed CLI against `100.79.178.107` with Tailscale 1.102.3 and Bun 1.4.2, using two disposable dev projects, Postgres and Redis. Both dev projects started with `BUCARGO_SKIP_MKCERT=true` and reused one coordinator. The receiving Mac discovered both branches and all four targets.

Cross-machine HTTPS, WebSocket echo, a PostgreSQL query and Redis write/read/delete passed. The first SSE event arrived in about 70 ms; the final event arrived five seconds later, verifying streaming rather than buffering. Switching the Mac's local Serve backend to loopback TCP fixed the original Unix-socket HTTP 502 failure.

Stopping the first worktree removed its three targets while the second branch and app remained reachable. Killing the coordinator with SIGKILL closed an active SSE stream and removed every owned foreground Serve session. The unrelated port 80 route survived both checks.

Three 20 MiB downloads took 29.6, 38.1 and 41.4 seconds (0.48–0.68 MiB/s). A plain Tailscale Serve route directly to the same app, bypassing Buncargo's gate, took 41.6 seconds. Tailscale reported the Frankfurt DERP relay and no direct connection. This comparison points to the relay/network path as the bottleneck; it does not establish direct-connection or cloud-agent throughput.

The test also exposed a coordinator identity bug with symlinked state paths (`/tmp` versus `/private/tmp`). Bundle installation now returns canonical paths; both runs subsequently adopted one coordinator. Packed-package verification covers initial installation and reuse through a symlinked home.

The old discovery LaunchAgent was paused only during testing. Its original Serve configuration, including the unrelated port 80 route, was restored after each run. Final cleanup confirmed the old service running and its directory returning HTTP 200. Disposable test processes, containers, volumes and socket directories were removed.

Release Please continues to publish the CLI and menu bar. There is no connection Worker deployment, Cloudflare credential or relay deployment in the release pipeline. Public `--expose` Cloudflare tunnels remain an independent feature.

References: [Cursor cloud setup](https://prod.cursor.com/docs/cloud-agent/setup#running-tailscale), [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys), [userspace networking](https://tailscale.com/docs/concepts/userspace-networking), [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
