# Tailnet acceptance

This record separates automated ownership tests from real network acceptance. It accompanies [the improvement plan](tailscale-review-plan.md). The feature remains unpublished; the unchecked release gates below are not covered by passing mocks.

## Repeating the checks

Use two real app worktrees on a chosen host and another connected Tailscale device. Build and install the coordinator, then start both worktrees with the updated CLI and `dev --tailnet`. Save `tailscale serve status --json` before testing so unrelated mappings can be compared afterward.

From the second device, check the printed app URLs for trusted HTTPS, redirects, simultaneous login and independent logout, direct WebSockets, Vite HMR and streams after more than 30 idle seconds. The app server's own idle timeout must permit the stream check. Confirm that the directory advertises both worktrees.

Keep a stream open in B while stopping and restarting A. A must retain its HTTPS URL when its loopback port changes; B's stream and login must survive. Check cleanup after an app crash, restoration of a missing owned mapping and coordinator restart. Never use `tailscale serve reset` on a shared host.

The recorded run below used temporary transport fixtures. Their scripts and package commands were removed after acceptance to keep the repository focused on the feature and regression tests. Fixture sessions tested cookie namespacing; they do not establish a consuming application's authentication behavior.

## September 7, 2026 environment

- Host: macOS 26.2, Apple silicon, Bun 1.4.2, Tailscale macOS app 1.102.3.
- Second device: MacBook Pro, Apple silicon, Bun 1.4.2, Tailscale macOS app 1.92.3.
- Test host: `mac-mini-hans.tail230528.ts.net`.
- Two isolated fixture roots on the host; no changes to the existing Lullu app or its dependencies.
- Existing HTTP Serve mapping on port 80 to localhost:3000 must survive setup, testing and uninstall.

Live installation uncovered and fixed two macOS issues: the GUI launchd domain was in on-demand-only mode and required `kickstart` after bootstrap; Tailscale's app executable entered GUI mode without terminal environment variables. Both CLI and Swift now set `TAILSCALE_BE_CLI=1`, as documented in the [Tailscale CLI reference](https://tailscale.com/docs/reference/tailscale-cli?tab=macos). Installation also waits for the first directory snapshot rather than treating the initial 503 as final failure.

## Live results

| Check | Result |
| --- | --- |
| Install and local directory identity over trusted HTTPS | Passed after fixing the live-discovered launchd/CLI-mode issues |
| Second-device trusted HTTPS and canonical redirects | Passed |
| Two concurrent fixture sessions; independent logout and reload | Passed in the probe and Chromium browser |
| Direct WebSocket upgrade and echo in both workspaces | Passed |
| Simultaneous SSE after 35 idle seconds | Passed after correcting the fixture's own server timeout |
| B's stream and browser login while A stops/restarts | Passed; stream completed after 35,880ms and B remained signed in |
| Stable A URL across changing upstream ports | Passed: the HTTPS port stayed 25498 across upstream ports 54519, 54819 and 55781 |
| Real Vite 6.4.2 hot module replacement through the existing plugin | Passed: module changed from `before-edit` to `after-edit`, one HMR update, page load count remained one |
| Crash cleanup with former upstream port occupied by another process | Passed; mapping removed in 4,998ms, B and port 80 retained |
| Restoration after removing one owned mapping | Passed in 910ms |
| Coordinator restart and reconciliation recovery | Passed |
| CLI peer listing against the live directory | Passed |
| Swift peer discovery and live directory decoding with no shell environment | Passed; an earlier slow request correctly returned Unreachable and a subsequent retry succeeded |

The connection used a Tailscale relay during part of the run and briefly slowed down. The completed transport probe is saved locally in `.buncargo/artifacts/tailnet-acceptance-result.json`. The Vite check used an isolated third fixture with the repository's existing `buncargoVite` plugin and injected hostname/HTTPS port; it did not touch Lullu.

## Local validation

- Full Bun suite: 1,014 passed, 8 optional integration checks skipped, no failures.
- The existing runtime cancellation test now waits for its disposable CLI's PID before aborting, removing a race where a fixed timer cancelled adapter preparation before the fixture existed.
- Swift store/schema tests: 6 passed; release app packaging and registry/directory smoke checks passed.
- Typecheck, formatting/lint, build and exact-package verification passed (20 exports, declarations, CLI, watchdog, both independent daemon bundles).
- Controlled warm reconciliation with 12 apps: 13 Tailscale commands before, 2 after. With simulated 5ms CLI latency, one local sample measured 87ms before and 66ms after; timings are noisy and are not a real startup benchmark.

## Cleanup and existing app status

Uninstall restored the original Serve JSON exactly, including the unrelated HTTP port 80 mapping, and removed the coordinator. All fixture processes exited. The temporary remote checkout, test allocation state, copied bundles and dedicated SSH authorization were removed; persistent lock inodes were retained. The original Lullu registry PID (19416) was no longer alive at the final check, and localhost:3000 did not accept a connection. No test stop command targeted that PID; this run cannot establish when or why the existing app stopped. Preservation of its Serve configuration passed, but continued availability of the app is not claimed.

## Remaining release gates

- Real consuming-app login, refresh, logout, OAuth/session-cache/impersonation cookies and direct voice WebSocket behavior across simultaneous worktrees. The supplied Lullu instance was preserved.
- Linux/systemd and other macOS Tailscale distribution variants.
- Host reboot, logout/login and Tailscale disconnect/reconnect. These would interrupt the existing server and SSH session and need a coordinated maintenance window.
- A genuinely denied peer must fail to reach both discovery and app ports. No policy changes or denied identity were supplied for this run.
- Expo/Metro remains outside the supported first version.

Coordinate the CLI, menu bar and consuming application's helper dependency versions before release. Do not publish based solely on this fixture or local unit tests.
