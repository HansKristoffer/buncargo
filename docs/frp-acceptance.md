# frp replacement acceptance — 10 September 2026

The replacement is implemented in PR #40. Hetzner serves the new connection directory and native frp HTTP routing at `connect.hanskristoffer.dk`; wildcard HTTPS is issued and renewed through Cloudflare DNS. This records observations, not throughput guarantees.

## Verified

- Pinned Linux production artifact built successfully. Activation and a second activation of the same artifact both passed. All three systemd services and certificate/backup timers are active.
- A fresh unprivileged Linux account ran ordinary `buncargo dev`, downloaded verified frpc, and published a working HTTPS app using only recipient tokens. No VPN, enrollment, root access, or hand-written frpc config was needed by the client.
- Two macOS worktrees shared one coordinator home while using different recipient lists. Receiver A saw its one run; receiver B saw both. Name, project, and branch metadata remained distinct.
- Real Vite served through a public wildcard HTTPS URL. Editing `main.js` updated the visible heading while `performance.timeOrigin` remained unchanged: an actual HMR update without page reload.
- Real Postgres `SELECT` and Redis `SET`/`GET`/`DEL` passed through separate private loopback visitors.
- Revoking one recipient closed an already-open Postgres query in 1.15 seconds. The other recipient's existing connection still executed a query. This exposed and fixed an initial implementation that restarted the entire publisher; proxy changes now use frpc reload.
- frpc's client status API reports bare proxy names, while its server hooks use namespaced names. Readiness now accounts for that distinction and for each recipient's own TCP proxy; working targets display `ready`.
- Live release smoke passed validated TLS, authenticated publication/discovery, streamed SSE, WebSocket echo, an exact 20 MiB payload, and private TCP. Individual Mac → Hetzner → Mac transfers measured 3.56 and 5.69 seconds across runs; this is a different route from the earlier Cursor benchmark and is not a like-for-like speed comparison.
- A database backup passed SQLite integrity checking, restored/decrypted into a disposable database, and invalidated all restored publication leases.
- The obsolete Cloudflare Worker, DERP service, and temporary frp benchmark services are retired. User-installed Tailscale applications are untouched.

## Automated checks

`bun run build`, `bun run lint`, `bun test` (1,020 passed, nine opt-in integration skips), `bun run verify:package`, `bun run test:integration-frp`, and `swift test --package-path menubar` (seven passed).

The real frp integration test exercises the pinned server/client processes with TLS and server authorization hooks, module HTTP requests, SSE, WebSockets, STCP, proxy reload preserving an unrelated open stream, revoked stream closure, and unauthorized admission rejection. CI also builds the production server artifact and runs the existing Docker, Linux/macOS, packed consumer, and menu bar checks.

## Application-specific follow-up

The earlier Lullu/Cursor benchmark demonstrated the speed improvement over its observed DERP route (see the replacement plan). The new production path has been tested with actual CLI/Vite/Postgres/Redis fixtures. Lullu itself still needs a new Cursor run with this build to repeat the same uncached page benchmark and exercise its authenticated SSE subscriptions, cookies, redirects, and voice WebSocket behavior. Those app-level flows cannot be established by a generic transport fixture. The old temporary benchmark URL is retired; stop its old Cursor test terminal with Ctrl-C.

## Transport compression — 10 September 2026

Commit `6611dd3` enables lossless compression for HTTP frp publications and gzip/zstd negotiation in Caddy for JavaScript, CSS, HTML, and JSON. SSE is excluded from HTTP encoding; private TCP stays uncompressed. No source rewriting, minification, bundling, or caching is introduced. The relay artifact is deployed; sandbox-side compression takes effect when running the updated CLI.

A Mac → Hetzner → Mac fixture returned 952,905 bytes collected from 200 non-test source files. Nine requests per configuration alternated order, used HTTPS keep-alive without response caching, and verified the decoded bytes exactly. These are individual payload transfers, not Lullu page loads or a Cursor network benchmark.

| Tunnel compression | Browser encoding | Median transfer | Median response body on wire |
| --- | --- | ---: | ---: |
| Off | Identity | 169 ms | 952,905 bytes |
| Off | Gzip | 99 ms | 276,614 bytes |
| On | Identity | 186 ms | 952,905 bytes |
| On | Gzip | 82 ms | 276,648 bytes |

Browser encoding reduced response-body traffic by about 71%. Both layers together gave the lowest median in this sample; tunnel compression alone did not improve this route. Internet variability and application request dependencies limit what this predicts for a full page. An incompressible 20 MiB fixture also passed, taking 4.23 seconds with tunnel compression enabled.

Validation passed: 1,021 unit tests, build, lint, packed consumer verification, both real frp compression modes on macOS and Linux, and all eight PR checks. The production Caddy handlers passed gzip/zstd negotiation and exact byte checks for source and source-map MIME types, identity/binary/already encoded responses, and immediate uncompressed SSE. The public release smoke passed encoded source delivery, SSE, WebSockets, and private TCP. Disposable benchmark publications, receivers, clients, and listeners were removed.
