# Tailcat acceptance — 2026-09-08

The Tailcat implementation was tested locally and between this Mac and the supplied Mac mini at `100.79.178.107`. SSH copied and launched the isolated fixture and cleaned it up. Application traffic used Tailcat's public DERP relay with direct UDP disabled (`TS_DEBUG_ALWAYS_USE_DERP=1`); SSH did not forward application traffic.

## Two-machine results

| Check | Result |
| --- | --- |
| Two independently addressed recipients | Passed |
| Directory preserves project and branch | Passed with local directory adapter and remote publishers |
| 2,000 module GETs per recipient, 16 concurrent clients | 4,000 total successful responses |
| WebSocket/HMR echo for both recipients | Passed |
| 1 MiB TCP echo and half-close per recipient | Both payloads complete |
| SSE after module loading and opening the TCP target | First event in 36 ms |
| Long SSE stream | All 70 events received over 70.2 seconds |
| Cleanup | Isolated remote publishers/app/echo server stopped and test directory removed |

This is a representative dev-server fixture, not a claim that the user's current Lullu cloud-agent session was upgraded or browser-tested. The production Worker was not deployed during this change; the two-machine test registered remote metadata with the local directory adapter.

## Regression and release checks

The local real-binary suite forces traffic through Tailcat's embedded test DERP and verifies:

- Multi-megabyte TCP transfer and half-close.
- 2,000 concurrent module requests, incremental SSE and WebSocket upgrade.
- Simultaneous independent forwards to one publisher, including opening TCP while HTTP is active.
- Browser bootstrap, app Authorization preservation and rejection of an untrusted Origin.
- Stopping a target closes existing streams and refuses later connections.
- Revoking one recipient closes its open stream while another stays usable.
- Directory outage closes sharing; a separate publication deadline bounds stale grants.
- The detached CLI helper opens/disconnects a remote app.
- A parent killed with SIGKILL does not leave its Tailcat child running.

The PostgreSQL acceptance test used a real disposable PostgreSQL 17 cluster and local directory through forced DERP: both recipients opened HTTP/SSE; SQL transaction/temp-table aggregation and a 1,010,000-byte COPY passed. A real Redis server was not part of this run; generic TCP forwarding is covered.

Build, lint, the full Bun suite, Swift menu tests, Worker dry-run bundle and packed-package consumer verification passed. The full Bun run reported 1,005 passed, 14 opt-in/skipped, zero failed; Swift reported six passed. The same forced-DERP suite also passed in an isolated Linux arm64 Docker container using Bun 1.4.2 and the automatically downloaded upstream Linux binary: six passed, zero failed. PR CI now runs it on macOS and Linux. Release deployment also runs that suite before deploying and the live-directory/PostgreSQL test afterward, before npm publication.

## Defects found and corrected

A single persistent WireGuard client identity shared across separate Tailcat processes caused their DERP connections to compete. Opening TCP could stall an existing HTTP/SSE forward; a stream's first event was delayed by about 51 seconds. Every forwarding process now uses fresh ephemeral keys. Access uses Tailcat's private per-recipient address and WireGuard pre-shared key, available only through authenticated directory reads. The same two-machine test then received its first SSE event in 36 ms.

Stopping the Tailcat process before its loopback gates had closed could discard TCP close frames. Shutdown now closes gates first and allows a bounded drain interval. A pipe guardian also terminates orphaned Tailcat processes when their owning CLI/helper dies.

## Operational limits

Tailcat's public DERP fleet is bandwidth limited. The tests demonstrate correctness and one observed latency, not a throughput/SLA guarantee. Operators can configure their own DERP map using `BUNCARGO_TAILCAT_DERPMAP_URL`; a permanent private relay was not provisioned during this task. Automatic binary installation covers Apple silicon and Linux x64/arm64. Other platforms require `BUNCARGO_TAILCAT_PATH`.
