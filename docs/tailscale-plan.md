# Minimal Tailscale access and topbar discovery

Status: implemented in source; macOS two-device transport checks passed, with platform and application release gates still open. Updated September 7, 2026. The npm package and menu bar release have not been published.

## Decision and user experience

Use the machine's existing MagicDNS name and Tailscale Serve, with a persistent HTTPS port for each worktree application. Buncargo manages registration, URL injection and cleanup. Tailscale handles private connectivity and HTTPS certificates. No owned domain, custom DNS records, Caddy, mkcert distribution or per-worktree Tailscale Service provisioning is needed.

Illustrative URLs:

```text
Worktree A web: https://devbox.tail123.ts.net:25173
Worktree A API: https://devbox.tail123.ts.net:23000
Worktree B web: https://devbox.tail123.ts.net:25174
Worktree B API: https://devbox.tail123.ts.net:23001
```

These illustrate allocated ports, not hardcoded app ports. The topbar shows project/worktree names and opens the correct URL, so users need not memorize ports. MagicDNS supplies the machine name; Serve supplies HTTPS proxy mappings. [MagicDNS](https://tailscale.com/docs/features/magicdns), [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).

Commands after installing a release containing this feature:

```sh
# Once on the server, with Tailscale installed and connected:
bunx buncargo tailnet install

# Daily use in any worktree:
bun dev

# Once on the laptop, for the optional updated topbar:
bunx buncargo bar install
```

The server installer enables remote access for eligible apps by default on that machine and installs a small background coordinator for cleanup and discovery. The laptop needs only connected Tailscale to open URLs. The topbar offers an “Other Tailscale devices” toggle; viewing does not require installing the server coordinator on the laptop.

Installation detects prerequisites and guides the user through Tailscale's existing login/HTTPS authorization flow when required. A restricted tailnet may need an administrator to allow the selected ports. Reuse existing policy when it permits access; do not require an admin API key, retag the device or replace policy. Finish with a verified setup or a precise next action. [Serve setup requirements](https://tailscale.com/docs/features/tailscale-serve).

Include `buncargo dev --tailnet` and `--no-tailnet` overrides, plus `tailnet status`, `doctor` and `uninstall`. CI stays local by default. Routine starts must not repeat setup questions or require per-worktree configuration.

## 1. Prove the platform integration

Validate two simultaneous HTTPS Serve mappings from a second tailnet device before implementing the full workflow. Check supported Tailscale versions, macOS App Store/Standalone CLI discovery, Linux permissions, background CLI access, HTTPS enablement and existing Serve/Funnel configuration. Use the installed client; no embedded Tailscale node or second VPN daemon.

The operation is equivalent to:

```sh
# Illustrative mapping; buncargo supplies actual ports:
tailscale serve --bg --https=25173 http://127.0.0.1:5173
```

Serve supports a configurable HTTPS port and automatic TLS. Background mappings persist independently of the command, so buncargo owns cleanup and reconciliation. Proxy directly to loopback applications; remote access must not depend on the local `.localhost` proxy or its CA. [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

Prove WebSocket upgrades, forwarded headers, streaming, same-machine access and listener coexistence on supported clients. Verify that updating one mapping leaves another worktree's active streams intact. Successful HTML loading alone is insufficient.

## 2. Persist ports and manage mappings

Add a machine-wide allocation registry under `~/.buncargo`, using existing state-path and file-lock primitives. Key reservations by stable project/checkout identity and app name, independently of run/session IDs. Keep the external HTTPS port separate from the upstream app port, so an upstream port change need not change the URL.

Choose a documented high-port pool excluding browser-blocked ports, the directory port, existing Serve/Funnel mappings and conflicting listeners. Validate platform binding behavior in the spike. Preserve reservations across stops and reboot. Never silently renumber an existing allocation on conflict; identify the conflict and support explicit reassignment. New allocations can choose another port. Release deleted-checkout reservations deliberately rather than on each stop.

The stability guarantee covers dev restarts, branch changes and reboot while checkout identity, allocation state and machine MagicDNS name remain. Machine renaming/re-enrollment, deleted allocation state or a recreated checkout may change URLs.

CLI and coordinator mutations share a machine-wide file lock. The background coordinator reconciles desired versus actual mappings every five seconds. Record workspace/app, owner session, process birth identity and upstream. Reuse `src/core/run-registry.ts`, `src/cli/run-publish.ts` and takeover rules. A reused app retains its actual URL mode; changing its injected environment requires explicit restart/takeover.

Inspect Serve state before updates, change only owned mappings, and compare ownership before removal. Never call global `tailscale serve reset`. Refuse ports already used by Funnel so private mode cannot become public accidentally. Remove mappings on shutdown, prune dead owners after crashes and reconcile after reboot. Reconciliation checks process birth identity before keeping or restoring mappings. Because Serve proxies directly to apps, crash cleanup has a polling window; it is not an instantaneous guard against port reuse while the coordinator is unavailable.

Keep the coordinator focused on lifecycle and discovery. Serve handles app traffic directly; no additional TLS server or remote routing gateway is required. Reuse launchd/systemd installation patterns and leave the existing root hosts daemon unchanged.

First version exposes only selected HTTP apps already marked `expose: true`; Lullu's web/API already qualify. Respect app selection during startup. Databases and other TCP services remain local. Keep this private mode separate from explicit public `--expose` tunnels.

During Tailscale loss, preserve running local apps and mark remote access unavailable; reconcile on reconnect. Explicit `--tailnet` startup fails clearly if unavailable. Default-enabled startup may continue locally with visible status, but must not advertise stale URLs or silently alter running apps' environment.

## 3. Integrate URLs, HMR and Lullu cookies

Reflect active private URLs in the existing `urls` object, while retaining `tailnetUrls` for inspection and keeping `loopbackUrls` fixed. Resolve and verify mappings before building app environments. Define browser URL precedence as explicitly requested public exposure, then active tailnet mode, then local URLs. Preserve public exposure compatibility and use a coherent web/API mode. Label private and public URLs distinctly.

Keep Lullu's `dev.config.ts` unchanged: its existing `publicUrls.platform ?? urls.platform` and API equivalent select the right origins because Buncargo resolves private URLs. Vite's server-side proxy uses the existing `API_LOOPBACK_URL`; no extra proxy environment variable is needed. Keep database connections local. Expo/Metro remote transport remains unverified; its API URL selection remains unchanged.

Reuse `src/vite/index.ts` through its existing injected hostname and port settings; no plugin API change is needed. Tailnet mode must inject the MagicDNS hostname, `wss` and the allocated external HTTPS port. Add the exact host to allowed hosts. Keep Vite's internal port separate from its browser-facing port.

Lullu proxies ordinary `/api` traffic through Vite, but voice WebSockets connect directly to the API. Preserve both paths. Audit redirects and CORS/trusted origins; development CORS already permits remote origins, so no blanket expansion is needed.

Cookies ignore ports. Lullu currently uses Better Auth's fixed `platform` prefix with path `/`, so concurrent worktrees can overwrite sessions. Required work:

- Expose a stable workspace ID derived from buncargo's checkout identity.
- Provide `devCookiePrefix` through `buncargo/runtime` for the backend and the browser-safe `buncargo/client` for Expo. Buncargo supplies the workspace variables; Expo passes its literal public environment-variable read from app code. Preserve production, E2E and missing-ID defaults without local helper files or a config schema.
- Apply it consistently to session, cached/chunked session, OAuth state and impersonation cookies. Audit custom readers/writers and client helpers for fixed names.
- Keep the prefix stable across restarts and local/tailnet switches. The initial change may require logging in once again.
- Prove login, logout and refresh in one worktree do not alter another's login.

Buncargo supplies identity; each app owns its cookie configuration. Avoid generic cookie rewriting in a proxy. Namespacing prevents accidental collisions but is not a security boundary: hostname cookies are still sent across ports. This mode serves trusted development apps. Document the cookie requirement for other buncargo consumers rather than promising transparent isolation for every app.

Keep local aliases available, but advertise tailnet URLs as canonical for remote-enabled runs. Local and remote hostnames need not share a login. External webhook providers still need an explicitly public endpoint.

## 4. Publish a minimal directory

Expose a sanitized read-only projection of `~/.buncargo/runs.json` through the coordinator's loopback HTTP endpoint and one owned Serve mapping. Use a documented default HTTPS discovery port outside the app pool, selected and validated during implementation. Report an occupied port; allow an override with manual endpoint entry on clients.

Provide `/v1/info` and `/v1/runs` with protocol version, stable machine ID, timestamp, project/worktree labels, session IDs, app state and approved HTTPS URLs. Publish only opted-in runs. Omit credentials, environment variables, database/TablePlus URLs, filesystem paths and executable commands. Check process liveness on the host; remote clients never test remote PIDs locally.

Use a separate versioned network schema and shared TypeScript/Swift fixtures. Preserve local registry compatibility. Tailscale policy controls access to the directory and allocated app ports; discovery grants no additional access.

## 5. Discover peers in the topbar

Read peers visible to the current client using `tailscale status --json`, with CLI discovery that works without a shell PATH. Probe only the default directory port using bounded concurrency, short timeouts, caching and backoff. Allow manual peer/endpoint entry when visibility is restricted. No admin token, central registry or general port scan is needed. [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli).

Keep asynchronous remote reads in a separate `RemoteStore.swift`, retaining immediate local `RunStore` updates. Group by machine, then project/worktree. Distinguish offline/last-seen from a successful empty response. Deduplicate the local machine, identify runs by `(machineId, sessionId)` and poll more frequently while the menu is open.

Remote rows support Open and Copy URL. Omit non-exposed dependencies entirely; publish only shared HTTP apps. Validate response sizes, versions and URL schemes. Remote records must never reach local stop, simulator or shell actions; remote management is outside this first version.

Tailscale's endpoint collection describes ports and protocols rather than buncargo projects and worktrees; the directory owns that metadata. [Endpoint collection](https://tailscale.com/docs/features/services).

## Delivery and acceptance

Deliver three reviewable changes:

1. Minimal installer/coordinator, persistent Serve mappings, URL/Vite integration and Lullu cookie namespacing. Complete remote browser testing first.
2. Versioned directory and CLI peer listing.
3. Topbar discovery, machine grouping and offline handling.

Test two concurrent worktrees and two actual tailnet devices: trusted HTTPS without certificate installation, independent login/logout/refresh, API traffic, HMR, idle SSE beyond 30 seconds, direct voice WebSocket transport and redirects. URLs survive dev restart and reboot. Starting/stopping a worktree leaves the other's streams and login intact.

Cover crash cleanup, recycled upstream ports, allocation conflicts, reused apps, Tailscale/coordinator reconnects and preservation of unrelated Serve/Funnel configuration. Uninstall removes only owned mappings and the coordinator. Confirm setup adds no ordinary LAN/public listeners and denied tailnet peers cannot reach the endpoints.

For discovery, cover missing/disconnected Tailscale, absent CLI, blocked/offline peers, version mismatches, malformed/stale responses and secret-free serialization. The topbar remains responsive for local runs while remote peers are unavailable.

Run buncargo's required build, formatting/lint and Bun tests, plus Swift smoke tests for topbar changes. Run relevant Lullu types and focused auth tests and exercise the real browser flow. Mocked Serve tests verify ownership/failures but do not replace two-device acceptance.

## Built artifacts and local review

Subsequent hardening adds pending-removal ownership state v2, default-mode local fallback after safe rollback, transactional agent replacement, bundle-aware diagnostics, bounded reconciliation and generation-tracked remote refresh. See [the improvement plan](tailscale-review-plan.md) and [current acceptance record](tailnet-acceptance.md).

The implementation uses application ports 20000–29999 and directory HTTPS port 48443 → loopback 48444. `tailnet install --discovery-port=N` supports 40000–49999 except 48444; clients enter custom endpoints manually. `--tailnet` and explicit `--expose` cannot be combined. A public exposure request takes precedence over the machine default. The topbar polls every 30 seconds, refreshes when opened, and backs off failed peers to four minutes.

From the buncargo repository:

```sh
bun run build
bun scripts/verify-package.ts
bash menubar/scripts/package.sh
```

These create `.buncargo/artifacts/buncargo-7.6.1.tgz` (an unpublished local artifact retaining the current package version) and `menubar/BuncargoBar.app`. The updated daemon is bundled independently and copied into the user's Buncargo state directory during installation, so removing a package checkout does not remove the daemon script. Bun and Tailscale must remain at their installed paths. macOS uses a logged-in user's LaunchAgent; Linux uses a systemd user service, with user lingering needed after logout.

Before publishing, a source checkout can be used on the intended host:

```sh
# In the buncargo source checkout, after bun run build:
bun src/cli/bin.ts tailnet install

# In the Lullu worktree, invoke the updated CLI (replace the source path):
bun /path/to/buncargo/src/cli/bin.ts dev --tailnet
```

Lullu's lockfile still names the existing published version; local verification uses the new exact tarball. The new helper imports require that tarball or a new release: a clean install of the older version will not resolve them. Its original dev config remains unchanged. Update that dependency as part of releasing the feature; ordinary `bun dev` cannot gain this feature from an older dependency merely by installing the coordinator. Build the new topbar from source during review; `bar install` otherwise downloads the existing release.

## Verification status

The September 7 follow-up implementation and live two-device results are tracked in [tailnet-acceptance.md](tailnet-acceptance.md). The paragraphs below record the original implementation, before that follow-up.

Passed locally: Buncargo build, lint and Bun tests; the native menu bar build and shared TypeScript/Swift directory fixture smoke test; Lullu full lint/types and real browser auth checks. Cookie selection lives in Buncargo helpers, covered by server/client parity, production/E2E defaults and browser bundle checks; Lullu imports them directly in its existing auth configuration. A real local browser completed login, preserved its workspace-prefixed HttpOnly session after reload, and cleared its auth cookies on logout using the updated source CLI. Package verification checks an exact tarball in a clean consumer, including detached host and tailnet daemon bundles.

Still required on the intended server and another tailnet device: installation/HTTPS authorization, simultaneous worktrees, separate login/logout, trusted HTTPS, HMR, long-lived SSE, direct voice WebSockets, restart/reboot, ACL rejection and menu bar discovery against live remote directories. Mocked ownership/recovery tests do not establish those transport guarantees. Expo/Metro remains outside the supported first version.

No real Tailscale Serve configuration, tailnet policy, production setting or installed menu bar application was changed during implementation. Installation and any necessary tailnet policy changes require authorization for the intended machine. No domain or DNS provider selection is needed.
