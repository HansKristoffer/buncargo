# Releasing on merge

> **Status (2026-09-08): live.** First releases through the flow: `v7.10.0`
> on npm and `bar-v1.1.0`. Two things surfaced on the first run: the manifest
> had to be re-synced because 7.8.0 and 7.9.0 were published by hand while the
> flow was being built, and `publish.yml` had never actually published; npm
> read `candidate/*.tgz` as a GitHub shorthand, so the path is now `./candidate/*.tgz`.

## Today

The CLI ships by running `npm version` locally, pushing the `v*` tag and
dispatching `publish.yml` by hand. BuncargoBar ships by pushing a `bar-v*` tag.
The human picks both version numbers. Main is regularly several merged PRs ahead
of the last publish because nothing reminds anyone to release.

## Decision: Release Please, one release PR, squash merges

- **Release Please** over Changesets: the repo has two independently versioned
  artifacts with different tag prefixes, and `bar-v` is a contract that
  `core/menubar.ts` filters releases by. Changesets only understands npm
  packages.
- **Release Please** over semantic-release: a release PR is the one review step
  left. Semantic-release publishes on every merge, which at four or five merges
  a day is four or five npm versions a day.
- **One combined release PR**, not one per component. It lists only the
  components that changed. Shipping the CLI while holding the bar back is not a
  case worth a second PR.
- **Squash merges with conventional PR titles** decide the bump. `fix:` is a
  patch, `feat:` a minor, `feat!:` or a `BREAKING CHANGE:` footer a major.
  `chore:`, `docs:`, `refactor:`, `test:` do not release. A PR that touches only
  `menubar/` bumps the bar; anything else bumps the CLI; both if it touches both.

## The loop after this ships

1. A PR is opened with a conventional title and squash-merged.
2. `release.yml` runs on the push to main and creates or updates the release PR
   with the next versions and generated changelogs.
3. Merging the release PR creates the tags and GitHub releases. The same
   workflow run calls npm publication and the bar build.
4. If a publish job fails, rerun the failed job on that run. A full rerun also
   works: release targets are recovered from published GitHub releases whose tags
   resolve to the run commit, even when Release Please creates nothing new.
   Existing npm versions and complete menu bar assets are skipped.

Tags created by the workflow's own token do not trigger other workflows. That is
GitHub's loop guard, and it is why step 3 calls the publish jobs instead of
relying on the new tag. It is also why the release PR does not get CI runs: it
only changes version files and a changelog, so no status check should be
required on main (see step 9).

## Steps

### 1. Release Please config

`release-please-config.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
  "separate-pull-requests": false,
  "packages": {
    ".": {
      "release-type": "node",
      "package-name": "",
      "include-component-in-tag": false
    },
    "menubar": {
      "release-type": "simple",
      "component": "bar",
      "include-component-in-tag": true,
      "tag-separator": "-"
    }
  }
}
```

The root release's `package-name` is intentionally empty. It identifies the
release component, not the npm package name in `package.json`. With unprefixed
CLI tags and a combined release branch, it must stay empty: otherwise Release
Please treats a CLI-only release PR as standalone and rejects its unnamed
branch component as different from `buncargo`. CLI-only, bar-only and combined
releases must all remain recognizable after merging.

`.release-please-manifest.json` bootstraps from the current tags:

```json
{ ".": "7.7.1", "menubar": "1.0.5" }
```

Produces tags `v7.8.0` and `bar-v1.0.6`, matching the existing contract. The
first release PR bundles the PRs merged since `v7.7.1`; their titles are not
conventional, so the first changelog is thin. Everything after is clean.

### 2. `menubar/version.txt`

The `simple` release type bumps a `version.txt` in the component directory.
Create it containing `1.0.5`. `scripts/package.sh` reads it as the default
instead of the hard-coded `0.1.0`; the release workflow keeps passing
`VERSION` explicitly. Source installs are detected by `bar.json` saying
`appVersion: "source"`, not by the number, so local builds reporting the real
version changes nothing.

### 3. `release.yml`

The executable definition is [release.yml](../.github/workflows/release.yml).
It calls Release Please, then the Worker deployment gate, then the client
publishing workflows. Keep the dependency conditions there: a bar-only release
must tolerate a skipped Worker job, while a combined release must stop if the
Worker fails.

Release Please creates release records, but its `release_created` outputs are
true only on the invocation that creates them. `scripts/release-targets.cjs`
therefore reads the manifest versions, checks their published GitHub releases
and resolves each tag to an exact commit SHA. Only releases matching this run
are eligible. Ordinary pushes cannot deploy an older release just because its
version is still in the manifest. npm metadata and the two expected bar assets
make a full rerun safe after partial publication; API errors fail rather than
guessing whether a release exists.

### 4. `publish.yml` becomes callable and loses the verify matrix

- `on: [workflow_call, workflow_dispatch]`. The dispatch stays as the escape
  hatch for republishing a version by hand.
- Delete the `verify` job. CI already ran lint, tests, build and tarball
  verification on four OS/Bun cells for the PR and again for the merge to main.
  The release commit changes `package.json` and `CHANGELOG.md`. Keep the single
  Linux `candidate` job, since it produces the tarball, and have `publish`
  depend on it alone. Release time drops from about fifteen minutes to about
  five.

### 5. `release-menubar.yml` becomes callable and loses two triggers

- `on: workflow_call` with the `version` input, plus the existing
  `workflow_dispatch`. Drop the `push: tags: bar-v*` trigger: the tag is now
  created by the workflow token and would not fire it anyway.
- Delete the `verify` job and the `pull_request` trigger; they move to step 6.
- The `Publish release` step already handles a release that exists: it uploads
  the assets with `--clobber`. Release Please creates the release with notes
  from the changelog, so the `--generate-notes` branch becomes dead code and
  goes. Between the release being created and the zip landing, the CLI's
  update check skips the asset-less release and keeps offering the previous
  one, which `fetchLatestBarRelease` already does.

### 6. `menubar-ci.yml`

The path-filtered PR job from `release-menubar.yml` (Swift build, tests, smoke
test against the fixture registry) moves here unchanged, with the same
`paths:` list. One file, one purpose.

### 7. `ci.yml`: a named Lint check, and cancel superseded runs

Today `bun run lint` (tsgo typecheck plus `biome check`, which covers
formatting, lint rules and import order) runs inside the four-cell `test`
matrix, so a formatting slip shows up as four failed test jobs after the slow
parts have run. Borrowed from lullu's `pr-checks.yml`:

- A separate `lint` job: one Ubuntu runner, Bun 1.4.2, `bun install
  --frozen-lockfile`, `bun run lint`. It finishes in about a minute and is
  the check to name in branch protection if any check is ever required.
- `test` drops the lint step and keeps test, build and `verify:package` on
  the matrix.
- `concurrency: group: ci-${{ github.event.pull_request.number || github.ref
  }}` with `cancel-in-progress: true`, so a new push cancels the run for the
  previous one instead of queueing behind it. Not on `release.yml`, where a
  cancelled run could leave a tag without a publish.

Not borrowed: the PR summary comment (the checks tab already shows this), the
path filter (nothing here is slow enough to skip) and the shared setup
action (three workflows, four identical lines each).

### 8. Small deletions and fixes

- `package.json`: remove `publish:patch`, `publish:minor`, `publish:major`.
- `core/menubar.ts`: releases `per_page` from 20 to 100. CLI releases now
  appear in the list and the bar lookup skips them by prefix, so twenty is no
  longer comfortably enough.
- `readme.md` line 27 links to `docs/support-and-release.md` and
  `docs/startup-reliability-upgrade.md`; neither exists. Drop the sentence.
- `AGENTS.md`: replace the two-updater sentence under `menubar.ts` (the CLI is
  the only updater since 2026-09-06) and add the title rule:
  PR titles are conventional commits; `feat:` / `fix:` / `feat!:` release,
  `chore:` / `docs:` / `refactor:` / `test:` do not; touching `menubar/` alone
  releases the bar.
- Update the header comments in `publish.yml` and `release-menubar.yml` to
  describe the new triggers.

### 9. GitHub settings (manual, once)

- Pull requests: allow squash merging only; default squash message "pull
  request title". This is what makes the title the commit Release Please reads,
  and it ends the stray `Merge branch 'main'` commits.
- Branch protection on `main`: require a pull request. Do **not** require
  status checks: the release PR is opened by the workflow token, gets no CI
  run, and would be unmergeable.
- Actions settings: allow GitHub Actions to create and approve pull requests
  (Settings, Actions, General, Workflow permissions). Without it the action
  cannot open the release PR.
- npm trusted publishing already points at `publish.yml`; a called workflow
  keeps its own filename, so no change on npmjs.com.

### 10. First run

1. Squash-merge this branch with a conventional title, e.g.
   `feat: release on merge`. Commits that do not parse as conventional are
   ignored entirely, and none since `v7.7.1` do, so without this there is no
   release PR at all. The resulting PR proposes `7.8.0` and its changelog
   carries this one entry; the five earlier PRs ship in it silently. To force
   a specific number, put `Release-As: 7.8.0` in the squash commit body.
2. Merge it and watch the run: `release-please`, then `publish-npm`.
3. Make one `menubar/`-only `fix:` PR and confirm the bar path end to end.

## Later, not now

- Auto-merging the release PR turns this into publish-on-every-merge. Needs a
  personal access token or GitHub App token. Add it only if the release PR is
  being merged without being read.
- A PR title lint action (`amannn/action-semantic-pull-request`). Add it the
  first time a mislabeled title ships the wrong bump.
- Signing and notarizing the bar. Unchanged by this plan; the step still
  activates itself when the Apple secrets exist.

## Retrying publication

Rerun failed jobs or the complete release workflow. Release target recovery uses the exact commit's existing tags and skips already published npm versions and complete menu bar assets. No hosted connection backend needs deployment.
