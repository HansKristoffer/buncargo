# Checkout files

`options.checkoutFiles` lists gitignored files every checkout needs, usually dotenvs. Buncargo
keeps one copy per machine, the **file store**, copies it into each checkout, keeps those copies
current and never overwrites local edits. The code is `src/core/checkout-files/`; the commands are
`buncargo files` (`src/cli/commands/files.ts`).

agentgate syncs file stores between machines without buncargo's code. Everything under
[Contract](#contract) is shared with it: change both programs or neither, and say so in the PR.
`src/core/checkout-files/fixtures/` holds stores and repository-key cases both test against.

## Decisions

- **Separate from `envFiles`.** `envFiles` is what buncargo reads; buncargo does not read every
  checkout file (Expo reads `apps/expo-app/.env` itself).
- **Copies, not symlinks.** A symlink cannot hold a per-worktree change, and Docker build contexts
  do not follow symlinks out of the context.
- **Adopted without asking.** A checkout that has a file the store lacks puts it in the store, and
  a checkout that lacks one takes it from the store. Migrating a project that copied `.env.local`
  by hand is therefore a no-op once any checkout that has the file runs a command. Other
  checkouts are not searched: that cost git forks on every load for a one-time case.
- **The base tells edits from updates.** `<checkout>/.buncargo/files.json` records, per file, the
  store content the copy was last written from (`{ "version": 1, "files": { "<path>": { "base":
  "<sha256>" } } }`). It is buncargo's alone, not part of the contract.
- **The base's content stays in the checkout.** `files merge` is three-way, so whenever the base
  is recorded its bytes go to `<checkout>/.buncargo/files-base/<path>` (`0600`), read only while
  their hash is still the base. Not in the store: one checkout's base is no other checkout's, and
  the store's layout is the contract. A checkout synced before these copies existed gets one on
  the next load while its copy or the store still equals the base; when neither does, the merge
  runs from an empty base, so every difference is an addition or a conflict.
- **Merge is dotenv only.** Every line must be `KEY=value` (a quoted value may span lines), a
  comment or blank, no key set twice, and Node's `parseEnv` must agree on the keys; anything else
  is refused. The checkout's copy is the skeleton, so its comments and order survive; a key taken
  from the store brings its line(s) and the comment right above it. Conflicts are computed under
  the store's lock but asked about outside it (a prompt would outlive the 30 s stale-lock
  window), so the merge is computed again, under the lock, with the answers.
- **Synced in the loader.** `loadDevEnv` syncs after importing the config and before
  `createDevEnvironment`, which reads required `envFiles` (`environment/context.ts`) and would
  throw on a fresh worktree before any fix ran. Every command syncs, `exec` included; `doctor`
  loads with `syncCheckoutFiles: false` and `files status` never builds an environment, so the
  two inspect without writing. A library caller of `createDevEnvironment` (not `loadDevEnv`) gets
  no sync.
- **Cheap when in step.** A load reads without the lock and forks git once, for the repository
  key (about 16 ms on an M-series Mac). Only when something has to be written does it take the
  lock, read again and run `git check-ignore`.
- **`dev` reports, it does not fork again.** The "Checkout files are current" check is fast because
  it reads the report the load's sync left (`lastSyncReport`); `doctor` inspects instead. The
  gitignore check forks, so it is not fast and only `setup` and `doctor` run it.
- **Never values.** Output names files and dotenv keys (`files diff`), never values. Only
  `files export` writes values, to stdout.
- **`machine` is written with the entry.** Changing it in the config takes effect at the next
  `files save`; until then `export` still goes by the stored flag.
- **CI** syncs only when a store exists, so a job never invents one; `envFiles` `optional` still
  decides whether a missing file is an error.

## Sync rules

| Checkout copy | Store | Action |
| --- | --- | --- |
| missing | present | copy, record base |
| missing | missing | copy `template` and record no base, so the next load adopts it filled in; else leave missing |
| present, no base | missing | adopt into the store, record base |
| present, base | missing | the same: the store was emptied, refill it |
| present, no base | equal | record base |
| present, no base | different | local edits: leave |
| equal to base | changed | update the copy, print one line naming the file |
| changed | equal to base | local edits: leave |
| changed | changed, different | conflict: leave, warn with the fix (`files merge` first when every copy parses as dotenv) |

`files pull --force` turns the two "leave" rows into a copy, after backing the checkout's copy up
to `.buncargo/files-backup/<timestamp>/<path>`. `files save` writes the checkout's copy to the
store whatever its state. `files merge` writes the merged result to both, backing up the
checkout's copy the same way.

Refused, with a warning naming the fix: a path outside the checkout (also through a symlinked
directory), a symlink, a tracked file, a file git does not ignore (`buncargo setup` appends it to
`.gitignore`), and data over 1 MiB. Config paths are validated as in the contract below, plus no
empty or `.` segments, so each file has one spelling and one store entry.

## Contract

### Store location and repository key

The store root is `getStateDir()/files`, `$HOME/.buncargo/files`, relocated by `HOME` like the rest
of `~/.buncargo`. A repository's store is `<root>/<repository key>/`.

The key comes from `git remote get-url origin`, run in the checkout:

1. URL form `scheme://[user[:pass]@]host[:port]/path` gives `host/path`, port dropped. scp form
   `user@host:path` (the `user@` is required) gives `host/` followed by `path` as written.
2. Strip trailing `/` characters, then one trailing `.git`.
3. Lowercase the whole key.
4. It must match `^[a-z0-9.-]+(/[a-z0-9._-]+)+$`. Otherwise, or with no origin, the key is
   `local/<first 16 hex chars of sha256(realpath of the git common dir)>`.

`https://github.com/Bliss-Budget/budget-app.git` and `git@github.com:Bliss-Budget/budget-app.git`
both give `github.com/bliss-budget/budget-app`. `fixtures/repo-keys.json` lists more cases.

### Layout

Directories are `0700`, files `0600`.

- `manifest.json`: `{ "version": 1, "files": { "<path>": { "sha256": "<hex of data bytes>",
  "updatedAt": "<ISO-8601 UTC>", "machine": false } } }`
- `data/<path>`: the exact bytes.

`<path>` is a POSIX path relative to the checkout root, with no `..`, no leading `/` and no
backslash, naming at most 1 MiB of data. `machine: true` entries are never exported or synced to
another machine.

### Writing and reading

- Write: take the lock, write each data file (temp file and rename in the same directory), then
  the manifest (temp and rename), release.
- Remove: drop the manifest entry, then the data file.
- Read: trust the manifest. A data file whose sha256 differs from its entry is absent for now (a
  write is in progress) and is read again later. Data files without an entry are ignored.
- A store whose `version` a reader does not know is left alone, with a warning.

### Lock

`mkdir <store>/.lock` (atomic), then write `{ "pid", "host", "createdAt" }` to
`.lock/owner.json`. Remove the directory to release. A lock is stale when its pid is dead on this
host or it is older than 30 s; a lock without a readable `owner.json` is being created, unless the
directory itself is older than 30 s. A process that finds a stale lock removes it and tries again.
It is not buncargo's `withFileLock`: that is a kernel lock only buncargo's code takes.

### Commands agentgate calls

`buncargo files status --json`, inside a checkout:

```json
{ "version": 1, "repoKey": "github.com/acme/app",
  "files": [ { "path": ".env.local", "state": "in-sync", "machine": false } ] }
```

`state` is `in-sync`, `store-newer` (pull would update or create the copy), `local-edits` (the
checkout's copy differs and the store did not change since it was written, or the store has no
copy), `conflict` (both changed) or `missing` (neither has it).

`buncargo files pull [path…]`, after writing the store: applies the sync rules and never
overwrites local edits without `--force`. Exit 0 when every file matches the store or neither has
it, 1 otherwise.
