# Releasing Buncargo

Release-please owns CLI and BuncargoBar versions and changelogs. Squash PRs with conventional titles: `fix:` for a patch, `feat:` for a minor, and `feat!:`/a breaking-change footer for a major. Do not edit versions or changelogs manually.

The combined release PR tracks the root package (CLI plus relay) and `menubar/` separately. Root tags remain `v*`, bar tags `bar-v*`. Keep the root component's `package-name` empty: changing it breaks recognition of combined release metadata.

## Release graph

Merging the release PR triggers `.github/workflows/release.yml`:

1. Release-please creates the appropriate tags/releases. `scripts/release-targets.cjs` also resolves already-created releases at this exact commit for retries.
2. `deploy-connect.yml` builds a checksummed Linux relay artifact, uploads it for inspection, and deploys it to Hetzner. It validates HTTP health, relay TLS, and authenticated transport before allowing clients to ship. A bar-only release verifies the running server and skips rebuilding it.
3. The existing reusable npm and bar workflows publish their verified artifacts after the server gate succeeds.

The workflow explicitly invokes downstream jobs; tags created by the workflow token do not trigger additional workflows. A deployment failure blocks client publication. The initial server launch fails closed; subsequent failed activations restore the previous release directory.

## Credentials and state

Repository Actions secrets `CONNECT_DEPLOY_KEY` and `CONNECT_KNOWN_HOSTS` provide the dedicated SSH deploy identity and pinned host keys. The Cloudflare DNS token and SQLite encryption key remain on Hetzner under `/etc/buncargo-connect/`. See [relay operation](frp.md).

Build outputs live under `/opt/buncargo-connect/releases/<commit>`; the current symlink is activated atomically. Persistent database/certificate state is under `/var/lib/buncargo-connect/`. Certificate renewal may reconnect frpc clients. Inspect the three systemd journals and verify `/healthz` when investigating failures.

## Reruns

Rerun the failed release workflow after correcting credentials or infrastructure. Release targets are recovered from GitHub releases whose tags point at the run commit, even when release-please creates nothing new. Never guess a release from the latest unrelated tag.

Server deployment depends on `cli_released`, independently of `publish_npm`. An npm version already present must not prevent a missing/failed server deployment from running. Reinstalling the same checksummed server artifact and activating the same commit is safe. Existing npm versions and complete bar assets remain skipped by their existing publication logic. API errors fail the job rather than being interpreted as missing releases.

Manual publication workflows remain operator escape hatches; use the normal release workflow so the server gate is enforced.
