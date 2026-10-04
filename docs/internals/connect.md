# Connect

Operating the relay: [frp](../frp.md).

- `src/core/connect/` owns frp sharing. `cli/dev-connect.ts` registers per-run recipient intent
  only when `BUNCARGO_CONNECT_TOKENS` is configured; the run registry remains the lifecycle
  authority. The coordinator supervises one publisher per run and private receiver visitors, with
  guarded children and 45-second leases. Tokens never reach child app environments (see
  `child-env.ts` in [shared core](./core.md)).
- `connect/publisher.ts` gates loopback targets against process birth identity and lease expiry.
  frp owns HTTP/SSE/WebSocket and STCP transport. Browser actions open validated public URLs; TCP
  actions receive local visitor addresses.
- `server/connect/` is the encrypted SQLite directory and mandatory frps authorization plugin;
  `server/deploy/` owns the pinned release artifact and Hetzner deployment. Shared local and remote
  menu rows stay in Swift's existing target components.
