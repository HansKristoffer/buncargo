# Tailscale branch review and improvement plan

Reviewed September 7, 2026: `f2deafc..1cba7ea` (the feature and formatting commits; 41 changed files). This plan follows review of the TypeScript runtime, CLI integration, Swift discovery, packaging, tests, and the original `tailscale-plan.md`. This first section records the original review; implementation status follows below.

Keep the current architecture: direct Tailscale Serve mappings, persistent per-checkout ports, a small coordinator, and a separate read-only remote directory. The ownership journal, process birth identities, preservation of foreign mappings, browser-safe cookie helper, and shared Swift/TypeScript fixture are useful foundations.

## 1. Make local startup reliable when remote access is unavailable — P1

**Confirmed problems:** In `src/cli/dev-tailnet.ts`, local fallback only covers an unavailable coordinator. If the coordinator answers `/health` but Tailscale is disconnected, `runtime.acquire()` throws and ordinary `bun dev` fails. The daemon's health endpoint continues answering while its Tailscale refresh fails, so this is a normal outage path. An isolated reproduction returned `Connect Tailscale before enabling tailnet access` for default mode.

The same function reads persisted tailnet state before honoring `--no-tailnet` or CI. A second reproduction confirmed that corrupt tailnet JSON prevents a fresh explicitly local run from starting. It also checks coordinator health before determining whether any selected apps are eligible.

**Change:** Extract a pure mode/eligibility decision, followed by the necessary state and availability checks. Explicit `--tailnet` remains strict. For default mode, fall back after a recoverable availability failure only when partial mappings have been safely rolled back and reused apps do not require a different environment. Local-only paths should not require readable allocation state, while still detecting incompatible reused apps through the run registry. Preserve strict ownership validation for mutations.

**Acceptance:** Add `dev-tailnet.test.ts` covering disconnected Tailscale with a healthy coordinator, missing coordinator, no eligible apps, corrupt state with explicit local mode, CI, public exposure, cancellation, rollback failure, and reused apps. Assert final URLs and whether app spawning proceeds.

## 2. Finish ownership transitions and uninstall recovery — P1

**Confirmed problems:** `release()` and `clear()` in `src/core/tailnet/runtime.ts` stop at the first failed removal. `uninstallTailnet()` writes `enabled: false`, then calls `clear()`. A foreign mapping can therefore prevent removal of unrelated owned mappings and the directory, and leave the coordinator installed. App reconciliation does not consult `enabled` before restoring a mapping.

An isolated fake-Serve reproduction confirmed both that the second owned mapping remained after the first conflicted, and that reconciliation restored the second mapping after it was cleared externally, despite `enabled: false`.

**Change:** Attempt independent removals, persist each result, and aggregate failures. Persist explicit pending-removal intent so recovery removes remaining owned mappings rather than restoring them. Preserve foreign mappings and their actionable conflict records. Define when the coordinator remains installed to finish deferred cleanup and make that outcome visible.

**Related source finding:** `src/cli/run-cli.ts` only considers takeover when nothing new will spawn. Starting a new web app while reusing an API that was started locally can fail with “restart with --takeover”, but that flag does not fix this mixed selection. Plan mode transitions across the selected app set, honor explicit takeover for affected reused apps, and wait for ownership handoff as well as port release. The latter closes a possible race with asynchronous `onAppExit` lease cleanup.

**Acceptance:** Cover a first-allocation conflict followed by an independently removable allocation, interrupted uninstall, reconnect after pending removal, mixed new/reused apps, takeover with delayed lease cleanup, and a second session exiting without removing the first session's mappings. Use session/birth identity consistently when associating leases with runs.

## 3. Make installation and diagnostics describe actual readiness — P2

**Source findings:** `installTailnet()` replaces/restarts the agent before checking existing directory ownership or a requested port change. `/health` only identifies a listening coordinator; it does not report a successful reconciliation or bundle identity. `tailnet status`/`doctor` require successful Tailscale status before reporting persisted state, and `active: !!lease` describes recorded intent rather than a verified mapping. An older copied coordinator remains indistinguishable from a current one.

**Change:** Preflight configuration and ownership before replacing a working service, with a locked recheck before mutation. Make agent replacement recoverable and serialize installation operations. Record bundle version/hash and interpreter/binary paths using the existing hosts-service pattern. Report coordinator liveness, last successful reconciliation, pending cleanup, mapping availability, and version mismatch separately. Keep diagnostics useful when Tailscale is missing or disconnected; expose repair explicitly rather than hiding its effects.

**Acceptance:** Inject service/filesystem/process dependencies. Test failed service load and upgrade rollback, incompatible existing directory ports, concurrent install/uninstall, a stale bundle, a healthy HTTP listener with failed reconciliation, and status during disconnection. Verify the HTTPS directory endpoint before claiming network readiness, while distinguishing local verification from reachability on another device.

## 4. Bound coordinator work and expose startup cost — P2

**Source findings:** Reconciliation repeatedly shells out for Serve state per allocation, then the daemon reads Tailscale status, runs, and Serve state again for publication. Startup checks ports individually through `isPortInUse`, including a repeated check for a newly selected port. Slow commands run under a shared lock with a 120-second acquisition timeout. Repeated failures are logged every refresh without throttling, and tailnet preparation has no named startup timing phase.

**Change:** Reuse one verified state snapshot per read phase; refresh around external mutations where ownership safety requires it. Reuse the existing port-owner snapshot utility. Add a `tailnet` timing phase and useful command/lock metrics. Bound reconciliation duration, support cancellation, and reuse the existing hosts backoff/log-throttling primitives. Consider filesystem wakeups after correctness and measurements are established.

**Acceptance:** Assert command counts for a warm multi-worktree machine, preserved compare-before-mutate behavior, bounded shutdown during CLI failure, and recovery latency under lock contention. Report measured startup time before and after; do not remove locking to meet a benchmark.

## 5. Complete the remote discovery contract and refresh lifecycle — P2

**Source findings:** Swift validates timestamps, app status, URL host/port, and duplicate IDs. CLI discovery checks only the top-level version, peer identity/hostname, and that `runs` is an array. The Swift store deduplicates endpoints rather than machine identity, so a manual endpoint and an automatically discovered endpoint can display the same machine twice. Refresh tasks are not cancelled or invalidated when a machine is forgotten; a late successful result can append it again. Opening the menu bypasses failure backoff, and generic “Offline” hides validation/version errors.

**Change:** Define a TypeScript decoder for the versioned network schema and derive invalid cases from the shared valid fixture for parity with Swift. Keep endpoint candidates separate from machines keyed by machine ID and runs keyed by machine/session. Track refresh tasks or generation IDs so removal and disabling invalidate stale results. Prioritize known/manual peers, retain bounded concurrency, and distinguish unreachable, incompatible, stale, and successfully empty responses in the UI. Give explicit Refresh a deliberate retry policy.

**Acceptance:** Add Swift store tests with injected discovery/fetch/clock dependencies. Cover remove during fetch, disable/re-enable, duplicate machine endpoints, slow unknown peers, manual endpoints without a CLI, stale responses, malformed nested apps, unsupported versions, and preserved immediate local updates.

## 6. Establish real transport acceptance before release — release gate

The original plan explicitly leaves two-device acceptance pending. Preserve that distinction: fake Serve tests verify our state transitions, but do not demonstrate trusted HTTPS, stream behavior, browser authentication, or ACL reachability. Tailscale documents that background Serve mappings persist and resume across restart/reboot, making recovery testing particularly important. See the [official Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

**Deliverable:** An opt-in integration harness plus an acceptance record naming the tested Tailscale versions and macOS/Linux client variants. Run two worktrees from a second device and verify trusted HTTPS, HMR, direct WebSockets, idle SSE beyond 30 seconds, redirects, independent login/logout/refresh, upstream port changes, crash cleanup, reconnect, reboot, and preservation of unrelated Serve/Funnel mappings. Confirm denied peers cannot access either discovery or apps. Record coordinator absence after logout/reboot where the platform requires an active user session.

Keep Expo/Metro outside the supported first version. Coordinate the CLI, menu bar, and consuming application's cookie-helper dependency updates; the Lullu source changes described in the original plan are outside this branch and were not independently reviewed here.

## Suggested delivery order

Ship items 1 and 2 as focused correctness changes first. Follow with installation/diagnostics, then coordinator efficiency, then discovery polish. Begin the two-device harness early and complete its acceptance record before publishing the feature. Retain the existing architecture unless platform testing demonstrates a specific limitation that requires changing it.

## Review verification

- Dependencies installed with `bun install --frozen-lockfile`; lockfile unchanged.
- `bun run build` and `bun run lint` passed.
- Focused Tailscale, cookie-helper, and CLI tests: 38 passed.
- Swift release build and smoke tests passed, including the shared tailnet fixture and unsafe/stale response rejection.
- Exact-package verification passed: 20 exports, declarations, CLI, watchdog, browser helper, and both detached daemon bundles.
- Isolated reproductions confirmed default-mode outage failure, explicit-local failure on corrupt tailnet state, and incomplete uninstall followed by restoration while disabled.
- Full Bun suite: 984 passed, 8 skipped, 1 failed. The unchanged Docker timeout test in `src/container-runtime/async-execution.test.ts` failed because its fixture PID file was missing; all four tests in that file passed on an isolated rerun. This is not a clean full-suite pass; investigate test timing/isolation before release.
- No real Tailscale mappings, services, policy, or installed menu bar application were changed for this review.

## Implementation status — September 7 follow-up

Items 1–5 are implemented in the working tree, including regression tests. Installation now also handles two failures found on the live Mac mini: an on-demand-only launchd domain and the macOS Tailscale bundle entering GUI mode without terminal environment variables. Both TypeScript and Swift force CLI mode. The first HTTPS directory verification waits for the initial snapshot.

Item 6 used temporary two-workspace transport scripts; the [live acceptance record](tailnet-acceptance.md) retains the results and instructions for repeating the checks against real apps. The temporary scripts were removed during cleanup. Two-device HTTPS, cookies, redirects, WebSockets, idle SSE and directory discovery have passed. The acceptance record distinguishes fixture behavior from consuming-app auth and records the remaining platform, reboot and ACL gates. Nothing has been published.

The final local full suite passes (1,014 tests, 8 optional checks skipped); the earlier cancellation fixture race is fixed by waiting for the disposable process to start before aborting. Build, lint, exact package validation, Swift tests, app packaging and smoke checks also pass. Controlled 12-app warm reconciliation falls from 13 Tailscale commands to 2; real startup performance remains a separate measurement.
