# Checkout file store fixtures

Shared with agentgate, which reads and writes the same stores. Each directory under `stores/` is a
store root (what `~/.buncargo/files` holds) containing one repository's store. The contract is
`docs/internals/checkout-files.md`.

- `stores/basic`: `.env.local` and `apps/mobile/.env`, plus `.env.machine` with `machine: true`,
  which must never be exported or synced.
- `stores/mid-write`: the manifest names bytes the data file does not hold yet. Readers treat
  `.env.local` as absent.
- `stores/unknown-version`: a manifest with `version: 2`. Readers leave the store alone.
- `stores/orphan-data`: `data/.env.orphan` has no manifest entry. Readers ignore it.

`repo-keys.json` lists origin URLs and the repository key each one gives (`null`: the URL makes no
valid key, so the repository falls back to `local/<hash>`).
