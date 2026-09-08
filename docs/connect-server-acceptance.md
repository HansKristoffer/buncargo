# Two-machine release acceptance — September 8, 2026

**Result: the packed CLI and unmodified local helper passed the supplied-server acceptance through the stable Worker relay, using normal DNS.** The earlier Quick Tunnel DNS blocker is resolved by removing private Quick Tunnels from the design.

## Environment and path

The publisher ran on the supplied Mac mini at `100.79.178.107`, with Bun 1.4.2, Docker 29.1.3 and the packed Buncargo build based on the current 7.10.0 release baseline. These are local candidate artifacts; Release Please will assign release versions.

SSH installed the isolated fixture, launched the CLI and handled cleanup. Application and database traffic used `https://connect.hanskristoffer.dk` through outbound authenticated WebSockets. No SSH port forwarding, DNS proxy, resolver changes, hosts overrides or modified client wrapper was used.

The fixture was a Git worktree on branch `feature/remote-connect`, with a temporary home and unique Compose project. Ordinary `buncargo dev --no-hosts --keep-containers` received two independent tokens through `BUNCARGO_CONNECT_TOKENS`. It started an exposed browser app, Postgres and Redis; an app with `expose: false` was excluded. The receiving side used the built CLI's `connect token`, `open`, `revoke` and detached helper, each recipient in a separate temporary home.

## Results

| Check | Result |
| --- | --- |
| Automatic sharing without `--share` or public `--expose` | Passed |
| Two independent recipients discover one session | Passed |
| Project, branch and worktree metadata | Passed through the CLI directory reader |
| Selected `expose: true` targets only | Passed |
| Immediate access with normal DNS and unmodified CLI/helper | Passed |
| HTTP responses, SSE and WebSocket echo for both recipients | Passed |
| Unauthenticated loopback/relay requests and untrusted browser origin | Rejected |
| Postgres transaction and 1,010,000-byte COPY | Passed |
| Redis PING, SET/GET, 25 pipelined increments and Pub/Sub | Passed |
| Postgres query lasting 65 seconds and Redis reuse afterward | Passed across capability and registration renewals |
| Revoke one recipient while retaining the other | Passed |
| Pause publisher until heartbeat expiry | Discovery became Connecting; new access rejected |
| Resume publisher | Automatically reconnected on the same endpoint; new browser request succeeded |
| Normal CLI shutdown | Discovery withdrawn |

Three complete two-machine runs passed through the normal path. Fresh-token cold starts measured about 3.1 seconds and 3.3 seconds; the final run included the TCP drain fix and repeated the database, renewal, revocation and outage-recovery checks.

The live Worker integration test separately passed two recipients, HTTP/SSE, Postgres transactions/COPY and revocation with a disposable local database. Live testing caught Cloudflare's Blob default for standard WebSocket messages; the Worker now explicitly requests ArrayBuffer delivery before accepting sockets.

## Other release checks

- Full Bun suite: 1,009 passed, 9 opt-in/platform tests skipped, no failures.
- Linux (Bun 1.4.2 container): all 18 connection tests passed; the opt-in live test was skipped there.
- Typecheck/lint, build and packed-consumer verification passed.
- Swift tests: 5 passed. Universal arm64/x86_64 menu bar build and registry/selftest smoke checks passed.
- Local relay tests cover multi-megabyte streams, slow readers/backpressure, TCP half-close, expired/renewed capabilities, cross-recipient isolation, malformed frames, forged credit acknowledgements and publisher replacement. The bulk and slow-reader half-close checks passed 30 repetitions each after fixing a clean TCP shutdown that could truncate queued final bytes.

Native menu interaction against this particular server was not manually exercised. Swift decoding/store tests and bundle smoke checks are separate evidence. The menu presents the same validated metadata and invokes the CLI/helper used in the two-machine run. Internet latency, arbitrary databases and frontend-specific absolute URLs are not universally certified by these tests.

## Superseded Quick Tunnel finding

The first implementation carried private streams through per-run `*.trycloudflare.com` endpoints. Fresh hostnames repeatedly failed on the receiving computer's ordinary resolver due to negative caching. A diagnostic-only DNS proxy proved the transport could carry Postgres/Redis, but it was not an acceptable user setup or release result.

The replacement uses the existing stable Worker hostname for directory, control and data connections. There is no per-worktree DNS allocation. Transport readiness is now separate from application readiness, and outage acceptance checks the unavailable state as well as recovery. Public `--expose` continues to use the existing public tunnel feature.

## Cleanup and release boundary

Acceptance removes its recipient secrets, helpers, publishers, test containers, database volume and Compose network. Existing server workloads are outside the fixture and remain running. Inert random test-device hashes remain in the directory; registrations are withdrawn. SSH key access remains configured as requested.

The accepted Worker deployment is `3bda5f3b-ae24-4454-99aa-4586778169b3` at `connect.hanskristoffer.dk`. The backend is deployed separately. The npm package and menu bar remain release candidates until the normal PR/Release Please workflows publish them. Versions and changelogs are owned by those workflows.
