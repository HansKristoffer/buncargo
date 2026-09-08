# Connection directory operations

The `buncargo-connect` Worker serves `https://connect.hanskristoffer.dk`. It is deployed separately from the npm package and uses one SQLite-backed Durable Object per recipient. `wrangler.connect.jsonc` owns its route, rate limiter and storage migration. The application transport runs through Cloudflare Quick Tunnels to authenticated server connectors; application bytes never pass through the directory Worker.

## Deploy

Authenticate with `bunx wrangler login`, then deploy from this checkout:

```sh
bunx wrangler deploy --config wrangler.connect.jsonc
```

The deployed Worker already has `CONNECT_SIGNING_JWK` stored as a secret. Ordinary deployments preserve it. Do not generate a new signing key for each deployment: live publishers pin the public key when starting their connector. An intentional signing-key rotation requires restarting publishers so they acquire the new public key; existing capabilities expire within 60 seconds.

For a new installation, generate an extractable Ed25519 key pair with `jose.generateKeyPair("EdDSA", { extractable: true })`, export the private JWK with `exportJWK`, and upload it as the `CONNECT_SIGNING_JWK` secret using Wrangler's secret prompt or a private `--secrets-file`. Never commit or print the private JWK. Set `CONNECT_ORIGIN` and the custom domain together. `/v1/key` returns only the public key; `/health` returns the service identity and schema version.

Set `BUNCARGO_CONNECT_DIRECTORY` on clients and publishers when operating a different directory. HTTPS is required except for loopback development. Copied tokens contain no arbitrary credential destination. The default is `https://connect.hanskristoffer.dk`.

## Local development and verification

```sh
bun run connect:directory:local
# In a separate shell, for a disposable local identity/server:
# BUNCARGO_CONNECT_DIRECTORY=http://127.0.0.1:8787
bun test src/connect-directory src/core/connect src/cli/dev-connect.test.ts
swift test --package-path menubar
```

The local server binds loopback and keeps ephemeral state and keys in memory. It is not a persistent production server. Tests use independent random credentials and do not read the user's device credentials.

The opt-in live acceptance test needs `initdb`, `pg_ctl` and `psql` on PATH, plus cloudflared or permission to download it through Buncargo's existing tool installer:

```sh
BUNCARGO_TEST_CONNECT_E2E=1 bun test src/core/connect/connect.integration.test.ts
```

It creates isolated recipient records, an authenticated connector, a real Cloudflare tunnel and a temporary local Postgres cluster. It tests two recipients, HTTP/SSE, transactions, COPY and recipient revocation, then stops its own servers, withdraws its registrations and removes its temporary database. Recipient credential hashes remain as inert test records; there is no device-ID recycling API. It never connects to an existing database.

## State and credentials

`~/.buncargo/connect-device.json` contains the local device credential, copied registration token and the CLI invocation to use. It is private (mode 0600). `connect-helper.json` records the local helper port, process birth identity and local control credential; the helper log contains operational failures, not copied tokens. The helper is started on demand by `connect open` and owns listeners independently of the menu bar.

The directory stores credential hashes, sanitized session metadata and expiry. It never receives application environment variables, database passwords or local executable paths. Every publisher proves session ownership on updates. Copied connection tokens permit registration only; the recipient credential authorizes directory reads and short-lived connection capabilities.

`connect rotate` replaces the registration token for new runs. Existing registrations continue with session credentials. `connect revoke --session=<id>` invalidates one registration. `connect rotate --all` revokes all existing registrations and replaces the token; use this for a leaked token. Interrupted rotations retain pending intent locally and complete on retry.

## Limits and failure behavior

- Recipient registrations renew every 30 seconds and expire after 90 seconds without renewal. Reads filter expired records immediately. Terminal IDs are retained for at least a day to fence delayed requests; records are bounded to 100 per recipient.
- Each snapshot has at most 64 targets. Requests/responses have a 128 KiB limit. The Worker rate limit is 120 requests per minute per client IP; monitor shared cloud egress and raise it deliberately if necessary.
- Connectors allow at most 128 concurrent streams, with bounded binary frames and buffers. Short-lived capabilities expire within 60 seconds; open streams renew every 20 seconds and close if authorization cannot be renewed.
- Publishers retry directory/transport failures without killing local app processes. A restarted tunnel publishes its new endpoint with a newer revision. Clients open new connections; interrupted database transactions are never replayed.
- Quick Tunnel availability and capacity limits still apply. The private framed stream path supports SSE in the recorded live test, unlike direct public Quick Tunnel HTTP SSE.

Use `bunx wrangler tail --config wrangler.connect.jsonc` for Worker errors and Cloudflare's dashboard for traffic/storage/rate-limit metrics. Avoid adding request-body or Authorization logging. Deployments do not need access to any recipient's private credential.

## Recorded acceptance

On September 8, 2026, the deployed directory and a real Cloudflare tunnel passed the opt-in acceptance test: two independent recipients discovered branch metadata, opened the authenticated HTTP app, received SSE, and connected to a disposable Postgres cluster. A transaction and a 1,010,000-byte COPY transfer succeeded. Withdrawing one recipient invalidated its access while the second recipient retained its registration.

Local verification also covers WebSocket upgrades for HMR, an idle connection that renews authorization beyond its initial expiry, multi-megabyte byte streams with half-close, and CLI device setup plus detached-helper open/disconnect. Build, lint, the Bun test suite, Swift tests, package verification and the universal menu bar bundle smoke test pass. A later two-machine run exercised live Redis commands and Pub/Sub, but also found a cold-start DNS blocker; see the qualified results below.

The initial protocol supports single-endpoint TCP. Protocols advertising additional addresses (for example Redis Cluster), arbitrary app-specific absolute frontend URLs, and restoring broken database sessions are not made transparent by port forwarding. Use a same-origin development-server API proxy where possible. Native database authentication/TLS remains the database client's responsibility.

## Two-machine follow-up

[The supplied-server acceptance report](connect-server-acceptance.md) records a complete diagnostic run with real Postgres and Redis, and repeated failures resolving new Quick Tunnel hostnames through the client’s default DNS. This remains a release blocker; the diagnostic DNS workaround is not part of the product.
