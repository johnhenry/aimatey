# Publishing to npm

Publish model: **main is the release branch** (see the
[johnhenry/workflows README](https://github.com/johnhenry/workflows#the-publish-model-main-is-the-release-branch)).
Everything runs from one workflow, `.github/workflows/release.yml`, which
triggers only on `push` to `main` and `workflow_dispatch`. There is no
`release:` or tag trigger: never create a tag or a GitHub Release by hand to
cause a publish. The root package is private; every workspace is published by
`scripts/staggered-publish.sh` in dependency order.

## Release steps

1. **Add a changeset** with each change that should ship: `npm run changeset`
   (pick packages, bump type, summary). This writes a file under `.changeset/`.
   Merge your PR to `main` as usual.
2. **The "Version Packages" PR.** On every push to `main`, `changesets/action`
   opens or updates a PR titled `chore: version packages` that bumps
   `package.json` versions, updates internal dependency ranges, writes
   CHANGELOGs and consumes the pending changesets. Wait for CI on it.
3. **Merge the Version Packages PR.** That push to `main` is the release: the
   same workflow runs again, finds no pending changesets, and runs the
   `publish` command, `./scripts/staggered-publish.sh`.
4. **Tags and Releases are by-products.** Because publishing goes through
   `scripts/staggered-publish.sh` rather than `changeset publish`, the script
   itself prints a `New tag:  <name>@<version>` line and creates the local tag
   for every package it newly publishes; the action parses those lines, pushes
   the tags and creates one GitHub Release per package
   (`createGithubReleases: true`). Skipped or failed packages emit no tag line.

**One-time repository requirement.** `changesets/action` opens the Version Packages
PR with `GITHUB_TOKEN`, which needs both `permissions: pull-requests: write` on the job
(already set in the workflow) and the repo setting *Settings > Actions > General >
"Allow GitHub Actions to create and approve pull requests"*. Without the setting the run
fails at `creating pull request` ("GitHub Actions is not permitted to create or approve
pull requests"). Check / enable:

```bash
gh api repos/johnhenry/aimatey/actions/permissions/workflow
gh api -X PUT repos/johnhenry/aimatey/actions/permissions/workflow \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true
```

Pushes to `main` with no pending changesets and no new versions publish
nothing: every package is reported as already published and the run is green.

## What the workflow does

`release.yml` runs on Node 26 (matching `engines.node >=26`): install, build,
lint, typecheck, tests, then `changesets/action` with
`version: npm run version-packages` and `publish: ./scripts/staggered-publish.sh`.
npm auth prefers trusted publishing (OIDC via `id-token: write`, which also
signs provenance); the `NPM_TOKEN` secret remains as a fallback. Trusted
publishing trusts one repo and one workflow filename per package, so the file
must stay named `release.yml`: do not rename it or add a second publish
workflow. Runs
queue and never cancel (`concurrency` group `publish-${{ github.ref }}` with
`cancel-in-progress: false`).

`ci.yml` has a `workflow-lint` job that fails if any publish workflow drifts
from the model (release/tag triggers, missing `workflow_dispatch`, missing
no-cancel concurrency, missing `id-token: write`, Node pin not matching
`engines`).

## Verification

After the publish step the release workflow runs the shared
`johnhenry/workflows/.github/actions/verify-published@v1` action (with
`from-workspaces: true`). It polls `npm view <name>@<version> version` for every
workspace package (version read from its `package.json`) until it appears, or 10
minutes pass (polling every 20 seconds). It prints a table and fails the job if
any version never appears. It only runs when changesets actually published.

## Re-running / recovering

Re-run the failed workflow run, or use `workflow_dispatch` (Actions tab, Run
workflow) on `main`. The publish script is idempotent: a version already on the
registry (`EPUBLISHCONFLICT` / "cannot publish over the previously published")
is reported under "Already published" and is not a failure, so a re-run only
publishes what is missing. Use this when verification fails: `npm publish` can
report success for a version the registry never stores (seen with
`aimatey-wrapper@0.2.0`), and a re-run fixes it.

## Local dry run and tests

```bash
npm run release:staggered:dry-run                  # no publish, no verification
```

Script configuration (environment): `DELAY_BETWEEN_PACKAGES` (5),
`DELAY_BETWEEN_BATCHES` (30).

## Adding a new package

Create `packages/<name>/` with a `package.json` (`name`, `version`,
`engines.node >=26.0.0`, `publishConfig.access: public`) mirroring a sibling
package, then add it to the batch list in `scripts/staggered-publish.sh` after
the packages it depends on. A package missing from the script is never
published.
