# Connection directory and Tailcat operations

`https://connect.hanskristoffer.dk` is a discovery-only Cloudflare Worker. One SQLite Durable Object per recipient stores credentials, grants and expiring session metadata. Application traffic uses Tailcat directly or through a DERP fallback, and never enters the Worker. No DNS record is created for a worktree. See [architecture and sharing rules](cloud-connect-plan.md) for endpoint selection and code ownership.

## Deploy and release

The Worker deploys automatically when the CLI release PR from Release Please is merged. `release.yml` calls `release-connect.yml` in the same run, validates the Worker with the pinned Wrangler version, deploys it, and runs the live two-recipient HTTP/SSE/Postgres acceptance test. npm publication and a combined menu bar release wait for success. A bar-only release skips Worker deployment. The Worker follows the CLI version; it has no separate version file or release PR.

PR CI builds the Worker with `bun run connect:worker:check` without Cloudflare credentials. Production deployment needs the repository Actions secret `CLOUDFLARE_API_TOKEN`: scope it to the configured account and `hanskristoffer.dk`. Keep Account Settings Read and Workers Scripts Write; include Zone Read and Workers Routes Write for the domain. The broad Edit Cloudflare Workers template also grants access to products this Worker does not use, which can be removed. The account ID is pinned in `wrangler.connect.jsonc`. Local OAuth login is not a persistent CI credential. The workflow fails with a setup instruction if the secret is missing. [Cloudflare GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)

On a failed release deployment or live check, rerun the failed jobs in that release run. A full rerun also resolves existing releases at that exact commit, skipping npm versions and complete menu bar assets that already shipped. For a deliberate manual retry, dispatch **Release connection Worker** at the intended release tag. Deploying an older revision is an explicit rollback, so check protocol and Durable Object migration compatibility first. Keep Worker protocol changes compatible with already released clients; deployment happens before new client publication.

For local operations:

```sh
bun run connect:worker:check
bun run connect:worker:deploy
```

There is no signing key or `/v1/key` endpoint. The old `CONNECT_SIGNING_JWK` secret is unused and may be deleted. Old relay clients are unsupported. Update the CLI and BuncargoBar together, stop old cloud sessions, and restart the local helper. There is no legacy relay fallback.

## Tailcat binary and relay

Buncargo downloads Tailcat 0.6.0 lazily into `~/.buncargo/bin`. The shared tool installer handles bounded downloads, pinned SHA-256 checksums, executable/version verification and atomic installation under a file lock. Cached executables use the same installation receipts as other Buncargo tools. Linux x64/arm64 uses upstream release archives; Apple silicon uses the relocatable Homebrew Sonoma bottle, also suitable for newer macOS. No Homebrew installation is required. On other platforms build/install Tailcat 0.6.0 and set `BUNCARGO_TAILCAT_PATH` to its absolute executable path.

Tailcat's default relay fleet is bandwidth limited. For a controlled production fallback, run a Tailcat-compatible DERP server on a host with public connectivity and TLS, and publish its DERP map over HTTPS. Set `BUNCARGO_TAILCAT_DERPMAP_URL` to that URL on both publisher and recipient. The map defines the relay hostname/ports; it must be reachable from the sandbox. DERP is a rendezvous/fallback service, not an HTTP app proxy. Do not place it behind an ordinary Cloudflare HTTP proxy without verifying protocol support.

References: [Tailcat source and CLI](https://github.com/tailscale/tailcat), [Tailcat architecture and relay limitations](https://tailscale.com/blog/tailcat).

## Credentials and access

`~/.buncargo/connect-device.json` is mode 0600 and contains the directory owner credential, registration token and CLI invocation. Server and client WireGuard private keys are ephemeral and stay in Tailcat memory. Each client gets a new identity: reusing a key across multiple Tailcat processes makes their DERP connections conflict. Tailcat addresses contain a pre-shared key: treat the entire address as sensitive and do not add it to diagnostic logs.

Copied tokens allow registration only. Device owner credentials authorize listing, rotation and revocation. Session secrets authorize updating/withdrawing only that publisher's registration. The address is a bearer capability protected by its WireGuard pre-shared key. Only the directory owner can retrieve it; possession permits connecting. Never expose it through token-authenticated endpoints, analytics, or logs. Revoking a recipient destroys its ephemeral publisher and address. Application credentials, including database passwords and Authorization headers, stay application concerns.

`connect rotate` replaces the token for new publishers. Existing publishers retain their session grants. `connect revoke --session=<id>` withdraws one session; `connect rotate --all` withdraws all current sessions too. The publisher checks authorization every 10 seconds and closes on failure, with a 20-second deadline after its last successful renewal. Closing the recipient's Tailcat server ends its existing streams without affecting other recipients.

## Limits and failures

- Discovery leases expire after 90 seconds; UI/helper polling also removes stale forwards.
- Each recipient has at most 100 session/tombstone records and each snapshot at most 64 targets.
- Directory JSON is bounded to 128 KiB. The Worker permits 600 directory requests/minute/source IP. App module requests do not consume this quota.
- The helper permits at most 128 open target forwards. Each HTTP target reuses up to 32 upstream connections. Raw TCP forwarding uses normal stream backpressure.
- Tailcat failure closes current sockets. Publishers restart with fresh keys and metadata; clients reopen through the menu. Neither requests nor database transactions are replayed.
- Browser URLs remain local. Public HTTPS sharing needs a separate gateway; Tailcat addresses are not browser URLs.
- Applications embedding absolute sandbox-local API URLs need origin configuration, preferably a same-origin dev proxy. Redis Cluster and other protocols advertising additional addresses are not automatically rewritten.

## Verification

```sh
bun test src/connect-directory src/core/connect src/cli/dev-connect.test.ts
# Real binary, local TLS DERP, forced relay path (no public network after binary download):
bun run test:integration-tailcat
swift test --package-path menubar
# Deployed directory, public Tailcat relay, and real disposable PostgreSQL:
# Requires initdb, pg_ctl and psql on PATH.
BUNCARGO_TEST_CONNECT_E2E=1 bun test src/core/connect/connect.integration.test.ts
```

The local directory binds loopback and uses ephemeral in-memory state. It is a test adapter, not a persistent deployment. See [acceptance results](connect-server-acceptance.md) for what was actually exercised.
