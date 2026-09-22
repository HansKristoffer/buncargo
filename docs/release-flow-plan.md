# Releasing Buncargo

Release-please owns CLI and BuncargoBar versions and changelogs. Squash PRs with conventional titles: `fix:` for a patch, `feat:` for a minor, and `feat!:`/a breaking-change footer for a major. Do not edit versions or changelogs manually.

The combined release PR tracks the root package (the CLI) and `menubar/` separately. Root tags remain `v*`, bar tags `bar-v*`. Keep the root component's `package-name` empty: changing it breaks recognition of combined release metadata.

## Release graph

Merging the release PR triggers `.github/workflows/release.yml`:

1. Release-please creates the appropriate tags/releases. `scripts/release-targets.cjs` also resolves already-created releases at this exact commit for retries.
2. The existing reusable npm and bar workflows publish their verified artifacts.

The workflow explicitly invokes downstream jobs; tags created by the workflow token do not trigger additional workflows.

Remote environments connect peer to peer over iroh, so a release deploys no infrastructure of ours and nothing gates publication. See [remote environments](remote.md).

## Reruns

Rerun the failed release workflow after correcting credentials or infrastructure. Release targets are recovered from GitHub releases whose tags point at the run commit, even when release-please creates nothing new. Never guess a release from the latest unrelated tag.

Existing npm versions and complete bar assets remain skipped by their existing publication logic. API errors fail the job rather than being interpreted as missing releases.

Manual publication workflows remain operator escape hatches; prefer the normal release workflow.
