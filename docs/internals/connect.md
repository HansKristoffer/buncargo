# Connect

Operating the relay: [frp](../frp.md).

- `src/core/connect/` owns frp sharing. `cli/dev-connect.ts` registers per-run recipient intent
  only when `BUNCARGO_CONNECT_TOKENS` is configured; the run registry remains the lifecycle
  authority. The coordinator supervises one publisher per run and private receiver visitors, with
  guarded children and 45-second leases. Tokens never reach child app environments (see
  `child-env.ts` in [shared core](./core.md)).
- A run writes its intent before it calls the launcher. An idle coordinator decides to exit under
  the `connect-launch` lock, after one more look for intents, and first writes `ready: false`; the
  launcher adopts only a ready coordinator and otherwise starts a new one. Exiting without that
  lock left a run that registered in the last refresh interval unshared for its whole lifetime.
- `connect/publisher.ts` gates loopback targets against process birth identity and lease expiry.
  frp owns HTTP/SSE/WebSocket and STCP transport. Browser actions open validated public URLs; TCP
  actions receive local visitor addresses.
- `server/connect/` is the encrypted SQLite directory and mandatory frps authorization plugin;
  `server/deploy/` owns the pinned release artifact and Hetzner deployment. Shared local and remote
  menu rows stay in Swift's existing target components.
