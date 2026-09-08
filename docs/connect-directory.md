# Connection directory and relay operations

The `buncargo-connect` Worker serves `https://connect.hanskristoffer.dk`. One SQLite-backed Durable Object per recipient stores its grants and relays its application streams. `wrangler.connect.jsonc` owns the custom domain, storage migration, rate limiter and compatibility date. Private connections use outbound WebSockets to this stable origin; no Quick Tunnel or cloudflared installation is involved.

## Deployment

The Worker deploys automatically when the CLI release PR from Release Please is merged. `release.yml` calls `release-connect.yml` in the same run, validates the Worker with the pinned Wrangler version, deploys it, and runs the live two-recipient HTTP/SSE/Postgres acceptance test. npm publication and a combined menu bar release wait for success. A bar-only release skips Worker deployment. The Worker follows the CLI version; it has no separate version file or release PR.

PR CI builds the Worker with `bun run connect:worker:check` without Cloudflare credentials. Production deployment needs the repository Actions secret `CLOUDFLARE_API_TOKEN`: scope it to the configured account and `hanskristoffer.dk`. Keep Account Settings Read and Workers Scripts Write; include Zone Read and Workers Routes Write for the domain. The broad Edit Cloudflare Workers template also grants access to products this Worker does not use, which can be removed. The account ID is pinned in `wrangler.connect.jsonc`. Local OAuth login is not a persistent CI credential. The workflow fails with a setup instruction if the secret is missing. [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

On a failed release deployment or live check, rerun the failed jobs in that release run. For a deliberate manual retry, dispatch **Release connection Worker** at the intended release tag. Deploying an older revision is an explicit rollback, so check protocol and Durable Object migration compatibility first. Keep Worker protocol changes compatible with already released clients; deployment happens before new client publication.

For local operations:

```sh
bunx wrangler login
bun run connect:worker:check
bun run connect:worker:deploy
```

The deployed Worker already has `CONNECT_SIGNING_JWK`. Ordinary deployments preserve it. Do not generate a new key on each deployment: publishers pin its public key at startup. An intentional key rotation requires restarting publishers; old capabilities expire within 60 seconds.

For another installation, generate an extractable Ed25519 key pair with `jose.generateKeyPair("EdDSA", { extractable: true })`, export the private JWK and upload it through Wrangler's secret prompt or a private secrets file. Never commit or print it. Set `CONNECT_ORIGIN` and the custom domain together. `/v1/key` exposes only the public key; `/health` exposes service identity and schema version.

Set `BUNCARGO_CONNECT_DIRECTORY` consistently on publishers and recipients for another operator's directory. HTTPS is required except on loopback for tests. Tokens contain no arbitrary credential destination. Session relay URLs must match the configured origin and exact recipient/session path.

Worker deployments can terminate active sockets. Publishers reconnect automatically; application clients must open new connections. Interrupted transactions are never replayed.

## Local and live verification

```sh
bun run connect:directory:local
# For a disposable identity/server in another shell:
# export BUNCARGO_CONNECT_DIRECTORY=http://127.0.0.1:8787
bun test src/connect-directory src/core/connect src/cli/dev-connect.test.ts
swift test --package-path menubar

# Needs initdb, pg_ctl and psql on PATH; uses isolated random credentials:
BUNCARGO_TEST_CONNECT_E2E=1 bun test src/core/connect/connect.integration.test.ts
```

The local adapter binds loopback with ephemeral keys/state and runs the same relay engine. It is not a persistent production server. The opt-in test exercises the live Worker, two recipients, HTTP/SSE, a disposable Postgres cluster, transactions/COPY and revocation. It cleans up its servers, cluster and registrations. Inert random device credential hashes remain; device IDs are not recycled. [The two-machine report](connect-server-acceptance.md) covers the packed CLI and supplied server.

Cloudflare's current standard WebSocket API defaults binary messages to Blob. The Worker sets `binaryType = "arraybuffer"` before `accept()` because the relay consumes byte frames. Keep this assignment when updating the adapter. [Cloudflare binary-message documentation](https://developers.cloudflare.com/workers/runtime-apis/websockets/#binary-messages)

## Credentials and privacy

`~/.buncargo/connect-device.json` contains the private recipient credential, registration token and local CLI invocation (mode 0600). `connect-helper.json` records the loopback helper, process birth identity and control credential. The helper starts on demand and owns local listeners independently of BuncargoBar.

Copied tokens permit registration only. Private device credentials authorize directory reads and short-lived access capabilities. Per-session secrets let publishers update their own grants and attach relay sockets. The relay and publisher independently verify capabilities, and the publisher only dials its configured exposed loopback targets.

Directory storage contains credential hashes, sanitized metadata and expiry, not application environment values or database passwords. Application bytes pass through the Worker in memory and are not logged or persisted by Buncargo. TLS protects each network leg; the relay operator remains trusted. Database authentication and optional database TLS remain client responsibilities.

`connect rotate` changes registration tokens for new runs. Existing sessions retain their own credentials. `connect revoke --session=<id>` revokes one session; `connect rotate --all` also revokes current sessions. Interrupted rotations retain pending local intent and complete on retry.

## Limits and failures

| Control | Current behavior |
| --- | --- |
| Registration | Renew every 30 seconds; expire after 90 seconds |
| Publisher control | One outbound socket per session/recipient; ping every 15 seconds; unavailable after 45 seconds |
| Capability | Valid at most 60 seconds; open streams renew every 20 seconds |
| Pending stream | Publisher must join within 10 seconds |
| Recipient state | At most 100 session/tombstone records; terminal IDs fenced for at least one day |
| Targets | At most 64 per snapshot |
| Streams | At most 64 concurrent paired streams per recipient; each publisher also caps at 64 |
| HTTP metadata | 128 KiB request/response limit |
| Relay bytes | Frames at most 65,537 bytes; per-direction credit bounds in-flight data to 128 KiB plus one frame |
| Local channel | Backpressure at 256 KiB; defensive read-buffer ceiling 4 MiB |
| Directory rate limit | 600 requests/minute per source IP for setup, listing, publication, rotation and revocation |
| Session rate limit | Separate 6,000 requests/minute per source IP for access grants and relay upgrades; every request still requires recipient authorization |

New access requires both a live grant and ready publisher. Target stopping, withdrawal and token-wide revocation reconcile active streams immediately. Capability expiry still closes streams when authorization cannot be renewed. Lease expiry filters discovery immediately on read; control checks enforce stale publisher shutdown. Retrying a revoked session cannot resurrect its tombstone.

Publisher failures leave local applications running. Retry uses bounded backoff to 30 seconds. A recovered publisher uses the same stable origin/session endpoint and permits new streams. No random DNS record needs to propagate. Stale UI actions are disabled; helpers independently validate access.

## Capacity and observability

The first release uses standard WebSocket listeners, not Durable Object hibernation. An object remains active while its publisher sockets are connected, so budget for duration as well as requests/storage. App data also passes through the relay. Hibernation requires restoring stream/control state correctly and is a future optimization. [Cloudflare WebSocket lifecycle and billing](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

Monitor duration, request volume, rate-limit responses, relay failures and reconnects in Cloudflare. Shared cloud egress can reach the per-IP limit sooner than a single workstation. Use `bunx wrangler tail --config wrangler.connect.jsonc` for failures, but never add Authorization, payload or environment logging. Review account quotas before expanding usage; this implementation does not promise unlimited concurrency or zero cost.

Single-endpoint TCP works with Postgres and Redis. Protocols advertising other addresses, such as Redis Cluster, are not transparently rewritten. Frontends with absolute sandbox-local API URLs may need their own origin configuration; use a same-origin dev proxy where possible. Cookies are not isolated by port, so namespace development cookies as documented in the README.
