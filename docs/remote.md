# Remote environments

Copy a connection token from BuncargoBar's key menu or run `bunx buncargo connect token` locally. Save it in the cloud environment's secrets:

```sh
BUNCARGO_CONNECT_TOKENS='bc_share_<token-one>,bc_share_<token-two>'
BUNCARGO_CONNECT_NAME='Cursor cloud'
```

Start `buncargo dev`. All selected apps and services with host ports are shared; workers, jobs, and stopped targets are skipped. Without tokens the run stays local. `expose` is not a sharing filter.

There is no server to run and no account to create. The two computers connect directly over [iroh](https://docs.iroh.computer/what-is-iroh): a QUIC connection, authenticated and encrypted end to end with each computer's own key. When a direct path cannot be punched through, the connection falls back to a relay that carries ciphertext only.

The name groups topbar entries; it grants no access. Runs retain their project, branch, worktree, and distinct identity. Multiple tokens share one run with several computers. Tokens are trimmed, comma-separated, deduplicated, and limited to 16.

## Opening services

Every shared target gets a listener on the receiving computer. Apps open at `http://127.0.0.1:<port>`, databases at `postgresql://…@127.0.0.1:<port>`. There is no connect step: the address exists as soon as the run appears, and the port stays the same while the run does.

These addresses are reachable only from the computer holding the token. A shared app has no public URL. For a genuinely public address, use the separate `dev --expose` Cloudflare quick tunnel.

```sh
bunx buncargo connect status --json
bunx buncargo connect open <target-id>
bunx buncargo connect revoke <publisher-id>
bunx buncargo connect token --rotate
```

Revocation is immediate and permanent: the publishing computer's connection and every open stream close, and its key is refused from then on. Rotation stops a sandbox that still holds the old token from connecting again; it does not disconnect computers already connected. Other recipients keep their access in both cases.

The receiver key, its token secret, and the refused-publisher list live in `~/.buncargo/connect-receiver.json`; the publishing key lives in `~/.buncargo/connect-publisher.json`. Both are mode 0600. Never bake either into a sandbox image. Every dev invocation supplies its own recipients, even when several worktrees share one coordinator.

## Vite and streaming

`buncargoVite()` keeps HMR origin-relative. The browser's Host header is `127.0.0.1:<port>`, which Vite's host check always allows, so no wildcard `allowedHosts` entry is needed. Nothing in the path parses HTTP, so SSE, WebSocket upgrades, uploads and disconnects stream as the application wrote them.

Use the application's existing same-origin API proxy; a browser cannot reach a sandbox's `localhost` URL embedded in JavaScript.

Sharing errors never stop local development. Check `connect status` for the reason. Internet distance, relay fallback and app compilation still affect performance.

A receiving computer becomes findable once its coordinator has run and published its address. A token copied into a sandbox before that can fail to connect for a few minutes, because a resolver that asked too early caches the miss. The publisher retries with backoff and recovers on its own; running `buncargo connect status` once on the receiving computer first avoids it.

## Relays

By default both ends use the free relays and DNS discovery that number 0 operates. Those are documented for development and hobby use, are rate limited, and carry no uptime guarantee. A measured transfer over a relayed path ran at about 2.5 MiB/s with a small request answered in roughly 120 ms; a direct path is far faster, but no code can force one when the network between two computers refuses it. To move onto relays with guaranteed capacity, set the same values on **both** computers, because a publisher reaches a receiver through the relay that receiver calls home:

```sh
BUNCARGO_CONNECT_RELAYS='https://<relay-one>,https://<relay-two>'
BUNCARGO_CONNECT_RELAY_TOKEN='<relay auth token>'
```

Relay URLs come from an [Iroh Services](https://www.iroh.computer/pricing) project or your own [self-hosted relay](https://docs.iroh.computer/iroh-services/relays/self-hosted). The token is optional and only needed by relays that require authentication. Buncargo operates no relay and holds no account; billing and access are between the customer and their relay provider.

## Operation

There is no server, no DNS record, no certificate and no deploy step. A release ships the CLI and the bar and nothing else.

One coordinator per computer holds the endpoint and the listeners, launched on demand by the CLI or the bar. On a computer that has created a receiver token it keeps running, because that is what makes the computer reachable; a publishing-only computer's coordinator exits about a minute after its last run stops.

The coordinator carries the native iroh addon beside its own bundle in `~/.buncargo/bin`, under the same hash, because a native addon cannot be bundled into JavaScript and the bar runs that bundle from outside any `node_modules`.

## Verification

`bun run test:integration-iroh` binds two real endpoints, publishes a run between them over n0's relays and discovery, and exercises an HTTP response, an SSE stream, raw TCP with half-close, revocation closing an open connection, and a publisher offering the wrong secret. It needs network and no credentials. Ordinary `bun test` covers the wire contract, token encoding, loopback address validation and target projection. Swift fixtures validate the same directory the CLI emits.
