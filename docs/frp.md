# Remote environments

Copy a connection token from BuncargoBar's key menu or run `bunx buncargo connect token` locally. Save it in the cloud environment's secrets:

```sh
BUNCARGO_CONNECT_TOKENS='bc_share_<token-one>,bc_share_<token-two>'
BUNCARGO_CONNECT_NAME='Cursor cloud'
```

Start `buncargo dev`. All selected apps and services with host ports are shared; workers, jobs, and stopped targets are skipped. Without tokens the run stays local. `expose` is not a sharing filter. Linux and macOS x64/arm64 clients download verified frpc v0.71.0 without root or interactive enrollment. Outbound TCP 443 and 7000 must be reachable.

The name groups topbar entries; it grants no access. Runs retain their project, branch, worktree, and distinct identity. Multiple tokens grant the same publication to multiple computers. Tokens are trimmed, comma-separated, deduplicated, and limited to 16. Tokens authorize publication to a receiver; the receiver's separate owner credential stays on that computer.

## Opening services

Browser apps and APIs open `https://<random-target>.connect.hanskristoffer.dk/` directly. These URLs are public, subject to the application's own authentication. Removing a discovery grant cannot make a URL already known to someone private while other recipients continue using the app.

TCP services have no public port. Connect/Copy/TablePlus starts a private frpc visitor bound to `127.0.0.1` and returns the port that actually bound. Disconnect closes this computer's visitor. Each recipient has a separate database proxy and secret. Revocation closes that recipient's publisher gate and active streams within the 45-second lease bound; it does not stop the remote app or other recipients' database connections.

```sh
bunx buncargo connect status --json
bunx buncargo connect tcp <target-id> --json
bunx buncargo connect disconnect <target-id>
bunx buncargo connect revoke <publication-id>
bunx buncargo connect token --rotate
```

Rotation prevents new publications with the old token. Revoke existing grants separately. The private receiver credential and sharing state live under `~/.buncargo`; never bake these into a sandbox image. Every dev invocation supplies its own recipients, even when several worktrees share one coordinator.

## Vite and streaming

`buncargoVite()` keeps HMR origin-relative. frp selects a target by public hostname, then sends localhost as its upstream Host, so no public wildcard `allowedHosts` setting is required. Caddy and frp stream SSE and support WebSocket upgrades. Use the application's existing same-origin API proxy; a browser cannot access a sandbox's `localhost` URL embedded in JavaScript.

Sharing errors do not stop local development. Check `connect status` for registration, directory, relay or target failures. A directory outage expires gates and visitors; retry does not replay interrupted database operations. Internet distance, relay load and app compilation still affect performance.

## Server operation

The production stack runs on Hetzner at `178.104.193.175`: Caddy on HTTPS 443, frps on TLS TCP 7000, private HTTP routing on 8080, directory API on loopback 8081, and authorization hooks on loopback 8082. The apex and wildcard DNS-only A records point to this server. No record or certificate is created per worktree.

Before first activation, provision `/etc/buncargo-connect/cloudflare.token`, root-owned mode 600, with Zone DNS Edit and Zone Read scoped to `hanskristoffer.dk`. Caddy's pinned Cloudflare DNS module obtains and renews the apex/wildcard certificates. A systemd timer copies renewed apex certificates to frps and restarts it when necessary. Clients verify the relay's certificate against their CA bundle.

`server/deploy/build.sh <artifact-directory>` runs on Linux x64 and builds the directory executable, Caddy plus its DNS module, and verified frps. The artifact includes checksums and a commit ID. Deploy it under `/opt/buncargo-connect/releases/<commit>` and run its `activate.sh` as root. The current symlink changes atomically; failed activation rolls back to the previous healthy artifact. First activation without a previous artifact fails closed.

The installer creates a persistent storage encryption key in `/etc/buncargo-connect/server.env`. Back up that key together with the SQLite database; losing it makes the database unreadable. The daily `buncargo-backup.timer` uses SQLite's backup API, checks integrity, and retains seven days under root-only `/var/backups/buncargo-connect`. Run `systemctl start buncargo-backup` for an immediate snapshot; copy snapshots off the server for disaster recovery. Restore credentials/database together; startup invalidates publication leases so restored runs must revalidate. To restore, stop `buncargo-directory`, replace `server.env` and `directory.sqlite` with a matching snapshot, remove the stopped database’s `-wal`/`-shm` files, restore database ownership to `buncargo-connect` and mode 600, then start the directory and run the authenticated smoke test. Limit backup access to the operator.

Inspect `journalctl -u buncargo-directory -u buncargo-frps -u buncargo-caddy`. Never enable credential-bearing debug logging. Directory bodies are bounded, identities/publications are quota-limited, the API rate-limits requests, and credentials/database metadata are encrypted at rest. Keep admin/hook ports closed externally. Restrict SSH with the host firewall and permit public TCP 443/7000 in both host and Hetzner firewall rules.

The dedicated server is a single point of failure. On failure, local development continues and existing sharing leases expire. Deployments and certificate renewal can reconnect clients. There is no alternate transport.

## Verification

`bun run test:integration-frp` starts real pinned frps/frpc with local TLS certificates and exercises authorization, hostname routing, streaming, WebSockets, private TCP, and gate closure. It needs OpenSSL but no production secrets. Ordinary `bun test` covers directory credentials, grants, expiry, and process guards. Swift fixtures independently validate the wire contract and action URLs.

Release publication waits for the server deployment gate. See [release operation](release-flow-plan.md) and the [replacement acceptance plan](frp-replacement-plan.md) for the live cloud/browser performance checks.
