# Two-machine connection acceptance — September 8, 2026

**Result: transport functionality passed in a diagnostic run; ordinary cold startup is blocked by Quick Tunnel DNS reliability. Do not treat this as an unconditional release acceptance.**

## Environment

The publisher ran on the supplied Mac mini at `100.79.178.107`, using Bun 1.4.2, Docker 29.1.3 and the locally built Buncargo package. SSH was used to install the fixture, run the CLI and clean up. Application and database test traffic went through Cloudflare, not SSH forwarding.

The fixture was an isolated Git worktree on branch `feature/remote-connect`. It used a private temporary home directory and a uniquely named Compose project. The ordinary `buncargo dev --no-hosts --keep-containers` command received two recipient tokens through `BUNCARGO_CONNECT_TOKENS`. It started an HTTP app, Postgres and Redis marked `expose: true`; an unexposed app was excluded. The directory was the deployed `https://connect.hanskristoffer.dk` Worker.

## Results

| Check | Result |
| --- | --- |
| SSH key authentication | Passed; key access remains configured as requested. |
| Real CLI automatic sharing without `--share` or `--expose` | Passed. |
| Two recipients discover the same session | Passed. |
| Project, branch and worktree metadata | Passed through the CLI directory reader. |
| Only selected `expose: true` targets are published | Passed. |
| Immediate local access using default DNS | Failed repeatedly on fresh Quick Tunnel hostnames. |
| HTTP responses, SSE and WebSocket echo for both recipients | Passed with the diagnostic DNS workaround below. |
| Unauthenticated connector access and untrusted browser origins | Rejected as expected in the diagnostic run. |
| Postgres transaction and 1,010,000-byte COPY | Passed in the diagnostic run. |
| Redis PING, SET/GET, 25 pipelined increments and Pub/Sub | Passed in the diagnostic run. |
| Postgres query lasting 65 seconds and Redis connection used afterward | Passed across capability and registration renewals in the diagnostic run. |
| Revoke one recipient while retaining the other | Passed in the diagnostic run. |
| Stop the CLI and withdraw discovery | Passed in the diagnostic run. |
| Native menu bar interaction against this server | Not exercised; earlier Swift decoder/store tests and bundle smoke tests remain separate evidence. |

## DNS finding

The directory reported ready targets before this client's normal resolver could resolve the freshly allocated `*.trycloudflare.com` hostname. Both Bun and curl returned name-resolution errors. Direct DNS queries sometimes disagreed: Cloudflare's resolver returned records while Google DNS returned `NXDOMAIN` for AAAA, with a negative-cache TTL close to 1,800 seconds. Supplying a resolved address to curl while retaining the original HTTPS hostname reached the authenticated connector and received the expected HTTP 401.

A diagnostic-only loopback HTTP CONNECT proxy resolved the original hostnames through Bun's c-ares backend. A test CLI wrapper supplied that proxy to WebSocket connections. The original hostname, TLS certificate verification, directory authentication and capability checks were retained. No DNS settings or hosts-file entries were changed. This wrapper is not part of the shipping CLI and is not an acceptable user setup requirement.

One full diagnostic run passed all traffic, database, renewal and revocation checks. A later fresh-hostname run also encountered a resolution timeout. A delayed direct request to a previously healthy tunnel eventually returned HTTP 401 using normal DNS, but a complete run through the unmodified local helper was not completed before that session shut down. No default-path success is claimed.

## Release follow-up

Fresh-worktree acceptance must pass through the unmodified CLI/helper and normal client DNS, without a diagnostic proxy or manual resolver changes. Resolve the per-run tunnel DNS dependency and distinguish application readiness from transport availability before releasing. Repeat HTTP, TCP, renewal and revocation checks against the real server after that change.

## Cleanup

All acceptance publisher sessions, local helpers, temporary proxies, test containers, the test database volume and the test Compose network were stopped or removed. Temporary copied tokens and recipient device files were removed. Existing server applications and databases were left running. As with the earlier integration test, the directory retains inert random test-device credential hashes; registrations were withdrawn or allowed to expire. The SSH key remains installed for subsequent authorized access.
