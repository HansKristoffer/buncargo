# Tailscale sharing

Buncargo discovers environments through Tailscale's peer list. Each publishing machine exposes a small private directory containing projects, branches, worktrees and service addresses. There is no hosted directory or separate Buncargo account/token system.

## Existing computers and servers

1. Install and sign in to Tailscale. Publishers need version **1.102.3 or newer** for Unix socket Serve targets; receiving computers can use their existing supported Tailscale app.
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
- `publisher.ts` derives targets once per refresh and uses Unix socket gates for each target. It checks run/app process birth identity when accepting streams. Stopping a target closes existing streams at reconciliation. Daemon death closes every gate; an unrelated process reusing an app or listener TCP port cannot revive an old forwarding rule.
- `mappings.ts` journals ownership before calling Serve and verifies activation for both initial publication and recovery. Existing targets reserve their ports before new targets are allocated. Cleanup compares the exact hostname, port, protocol and backend, including foreground and Funnel conflicts. It never calls `serve reset`. A crash leaves safe, closed Unix endpoints; the next coordinator removes only still-owned mappings before publishing.
- `discovery.ts` probes only authenticated Tailscale peers with bounded concurrency, body sizes and deadlines. It rejects stale metadata, redirects, wrong machine identity and target URLs pointing anywhere other than the expected peer. No executable path or secret is accepted from a remote directory.

Sharing state lives in `tailnet-coordinator.json` and `tailnet-mappings.json` in the normal machine state directory. A different Buncargo build does not replace a live coordinator underneath other worktrees: stop its dev sessions and allow the idle coordinator to exit before starting the new build.

## Verification and releases

Ordinary tests cover discovery validation, ownership conflicts, crash recovery, TCP half-close, streaming, selected targets and menu actions. The Linux integration suite installs the real pinned binaries and starts a userspace daemon without a TUN device or an account. Live tailnet acceptance additionally requires an enrollment key and actual cloud sandbox: verify two simultaneous agents, private HTTP/SSE/WebSocket, Postgres/Redis, one worktree stopping while another remains live, and a denied peer. Measure throughput on that actual route before comparing it with other transports.

Implementation verification (2026-09-09):

- Bun: 1,025 tests passed, nine optional integration tests skipped; lint, build and packed-package verification passed, including the standalone menu discovery command. Regression tests cover port reservation during recovery, verification of restored mappings and stale coordinator readiness.
- macOS: six Swift tests, the ARM64 release build and menu bar smoke test passed.
- Linux: 17 tailnet tests passed on the Hetzner server, including the real pinned userspace daemon. A separate run as the unprivileged `nobody` user reached the login state without a TUN device.
- Two real CLI dev runs shared one coordinator and retired independently with a simulated Tailscale control CLI. This verifies orchestration and ownership, not authenticated network access.
- A real Vite 6.4.2 server delivered file-change HMR updates through two different proxy origins simultaneously.

Authenticated Cursor enrollment, cross-machine service access and throughput remain unverified: these checks require a real enrollment key and cloud agent.

Release Please continues to publish the CLI and menu bar. There is no connection Worker deployment, Cloudflare credential or relay deployment in the release pipeline. Public `--expose` Cloudflare tunnels remain an independent feature.

References: [Cursor cloud setup](https://prod.cursor.com/docs/cloud-agent/setup#running-tailscale), [Tailscale auth keys](https://tailscale.com/docs/features/access-control/auth-keys), [userspace networking](https://tailscale.com/docs/concepts/userspace-networking), [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).
