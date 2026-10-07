# Publishing to npm

All packages publish under the `@johnhenry` scope from one workflow:
`.github/workflows/release.yml`. The root package is private; every workspace
is published by `scripts/staggered-publish.sh` in dependency order.

## Release steps

1. **Add changesets** with your changes: `npm run changeset` (pick packages,
   bump type, summary). This writes a file under `.changeset/`.
2. **Open a version PR.** On a branch, run `npm run version-packages`. It bumps
   `package.json` versions, updates internal dependency ranges, writes
   CHANGELOGs and deletes the consumed changesets. Commit those files and open a
   PR; wait for CI.
3. **Merge the version PR** into `main`.
4. **Create a GitHub Release** `vX.Y.Z` on `main` (Releases, Draft a new release,
   Publish). Publishing the release triggers `release.yml`. Do not push tags by
   hand; the workflow does not listen for them.
5. **`release.yml` runs** on Node 26 (matching `engines.node >=26`):
   - `validate`: build, lint, typecheck, tests.
   - `publish-npm`: build, then `scripts/staggered-publish.sh` (needs the
     `NPM_TOKEN` secret).
6. **Verification.** After the last batch the script polls
   `npm view <name>@<version> version` for every package (version read from its
   `package.json`) until it appears, or `VERIFY_TIMEOUT` minutes pass (default
   10, polling every `VERIFY_INTERVAL` seconds, default 20). It prints a table
   and exits non-zero, failing the job, if any version never appears.

## Re-running / recovering

`release.yml` also has `workflow_dispatch` (Actions tab, Run workflow). The
publish script is idempotent: a version already on the registry
(`EPUBLISHCONFLICT` / "cannot publish over the previously published") is
reported under "Already published" and is not a failure, so a re-dispatch only
publishes what is missing. Use this when verification fails: `npm publish` can
report success for a version the registry never stores (seen with
`aimatey-wrapper@0.2.0` in the v0.3.0 run), and a re-run fixes it.

## Local dry run and tests

```bash
npm run release:staggered:dry-run                  # no publish, no verification
node --test scripts/verify-published.test.mjs      # verification logic, mocked npm
node scripts/verify-published.mjs @johnhenry/aimatey-core   # check one package
```

Script configuration (environment): `DELAY_BETWEEN_PACKAGES` (5),
`DELAY_BETWEEN_BATCHES` (30), `VERIFY_TIMEOUT` (10, minutes),
`VERIFY_INTERVAL` (20, seconds).

## Adding a new package

Create `packages/<name>/` with a `package.json` (`name`, `version`,
`engines.node >=26.0.0`, `publishConfig.access: public`) mirroring a sibling
package, then add it to the batch list in `scripts/staggered-publish.sh` after
the packages it depends on. A package missing from the script is never
published.
