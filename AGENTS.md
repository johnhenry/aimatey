# Agent playbook

Universal AI Adapter System: a provider-agnostic interface for AI APIs.
npm workspaces monorepo (`packages/*`, glob-declared -- there is no
explicit dependency-ordered list), 23 published packages, Node >= 26,
Vitest for tests, orchestrated with Turborepo. Frontend adapters translate
client formats (OpenAI, Anthropic, Gemini, Mistral, Ollama, Chrome AI) into
a universal Intermediate Representation (IR); the Bridge/Router core applies
middleware, routing strategies, circuit breaking, and fallback; backend
adapters execute the IR against 30 provider APIs. **Packages here do build
to `dist/`** (ESM + CJS + types) -- cross-package types and imports resolve
through each package's built output, not its source, so a stale or missing
build produces misleading failures that look like real bugs.

`CLAUDE.md` in this directory is a symlink to this file.

## Workspace structure and build order

`workspaces` is declared as the glob `packages/*`, not an explicit
dependency-ordered array -- Turborepo derives the actual build order itself
from each package's `dependsOn: ["^build"]` declaration (build a package's
own dependencies before the package). The dependency layering, in the order
a change should generally be made in:

| Package | Role |
| --- | --- |
| [`aimatey-types`](packages/aimatey-types) | All type definitions, IR schema (`src/ir.ts`) -- everything else depends on this |
| [`aimatey-errors`](packages/aimatey-errors), [`aimatey-utils`](packages/aimatey-utils) | Errors and shared utilities; `aimatey-utils` must not depend on `aimatey-core`/`backend` |
| [`aimatey-core`](packages/aimatey-core) | `Bridge`, `Router`, `MiddlewareStack` |
| [`backend`](packages/backend) (`@johnhenry/aimatey-backend`) | 30 backend provider adapters (subpath exports); `backend-browser` is the separate browser-safe subset |
| [`frontend`](packages/frontend) (`@johnhenry/aimatey-frontend`) | 7 frontend request-format adapters. Frontend must not depend on backend |
| [`middleware`](packages/middleware) | 10 middleware types (logging, caching, retry, cost tracking, security, …) |
| [`http.core`](packages/http.core) + [`http`](packages/http) | Framework-agnostic HTTP handler + 6 framework adapters |
| [`react-core`](packages/react-core), `react-hooks`, `react-nextjs`, `react-stream` | React integration |
| [`wrapper`](packages/wrapper) | SDK-compatible wrappers |
| [`cli`](packages/cli) | `ai-matey` CLI |
| [`native-node-llamacpp`](packages/native-node-llamacpp), `native-apple`, `native-model-runner` | Local model backends |
| [`aimatey`](packages/aimatey) | Main umbrella package; publishes as `@johnhenry/aimatey` |
| [`aimatey-testing`](packages/aimatey-testing) | Test utilities (internal/dev-facing) |

**Tests are centralized** in `/tests` (`unit`, `core`, `http`, `integration`,
`contracts` suites, run via `vitest.workspace.ts`), not per-package.

## The verification loop (before every push)

Build must run before typecheck or test -- cross-package imports resolve
through `dist/`, not source, so a stale or missing build produces
misleading failures that look like real bugs.

```bash
npm run build        # turbo run build (ESM + CJS + types) && fix-cjs-package-json.js
npm run typecheck     # turbo run typecheck
npm test              # vitest run -- what CI actually runs
npm run lint          # turbo eslint; `npx turbo run lint --force` bypasses the cache
npm run changeset      # create a changeset for every user-facing change
```

A genuinely fresh clone before a release:
`git clone . /tmp/aimatey-verifyN && cd $_ && npm ci && npm run build && npm test`.
This is the only way to catch "works on my checked-out tree" bugs (missing
`files` entries, undeclared deps) -- with 23 published packages, a single
missing `files` entry or undeclared cross-package dependency is easy to miss
locally where everything is already hoisted and built.

## Repo-specific gotchas

- **Zero runtime dependencies is a core constraint for published packages.**
  Do not add npm dependencies to anything under `packages/*` that publishes
  -- optional peer deps like `zod` are the sanctioned exception. This is
  enforced by convention, not tooling, so review new `package.json`
  `dependencies` entries by hand.
- **Semantic drift is tracked via `IRWarning`, not silent normalization.**
  When a format conversion is lossy or normalized (e.g. a provider doesn't
  support a requested parameter and it's dropped or approximated), attach an
  `IRWarning` to `request.metadata.warnings`/`response.metadata.warnings`
  rather than failing silently or just logging. `createSecurityMiddleware`'s
  `content-redacted` warning is the same pattern applied to redaction.
- **Model data lives in one place.** Pricing, context windows, and
  aliases live in the model registry in `@johnhenry/aimatey-utils`
  (`registerModels()`) -- update the data file there rather than hardcoding
  model IDs in a backend adapter or elsewhere.
- **Every user-facing change needs a changeset** (`npm run changeset`;
  `patch` = fix, `minor` = feature) -- a merged PR without one does not get
  picked up by `changeset version`/`changeset publish`, so the fix ships in
  source but never reaches npm until someone notices and backfills one.
- **The published npm package name doesn't always match the package
  directory.** `packages/http.core` publishes as `@johnhenry/aimatey-http.core`
  (renamed from `aimatey-http-core` for naming consistency with other
  multi-word packages -- see `CHANGELOG.md`'s breaking-change entry); don't
  assume directory name mirrors package name when wiring cross-package
  dependencies or docs links.

## New-package definition of done

Adding a package under `packages/` means all of the following, not just
`npm init`:
- `tsconfig.json` (+ the `tsconfig.base.json`/`tsconfig.cjs.json`/
  `tsconfig.esm.json`/`tsconfig.types.json` split) matching an existing
  package's shape, so it builds ESM + CJS + types the same way every sibling
  does.
- `readme.md` with the badge row, provenance note (previously-unscoped name
  if any) and `## Family` section per the family standard where a real
  cross-repo relationship exists; `CHANGELOG.md` entry.
- `"engines": { "node": ">=26.0.0" }` matching the root.
- Added to this root readme's `## Package Reference` tables and, if it's a
  package a user would reach for directly (not pure infrastructure), to
  `## Which package do I want?`.
- Added to `scripts/staggered-publish.sh`'s batch list in dependency order
  (see `## Releases` below for why this script's batches are hand-maintained
  rather than derived) and to `docs/PUBLISHING.md`.
- See `## Adding a new backend adapter` in `readme.md` for the specific,
  narrower checklist when the new package is a backend/frontend adapter or
  middleware type rather than a new top-level package.

## Non-goals

Bringing the `packages/backend`/`packages/frontend` split protocols back
into a single package, or reintroducing a root-level `src/` alongside
`packages/` (removed per `CHANGELOG.md`'s `[Unreleased]` entry), are
deliberately out of scope -- both were tried and reverted for the reasons
recorded there.

## Releases

See `docs/PUBLISHING.md`. Root `CHANGELOG.md` tracks the aggregate release
history across all packages (it keeps its own `[Unreleased]` /
`[<version>]` structure, independent of any single package's version, since
no single number describes 23 independently-versioned packages); each
package's own `readme.md`/`CHANGELOG.md` records its specific version
history. Releases use [Changesets](https://github.com/changesets/changesets)
(`npm run changeset` → `npm run version-packages` → `npm run release`, i.e.
`turbo run build && changeset publish`) for normal releases. A separate
`npm run release:staggered` (`scripts/staggered-publish.sh`) exists because
Changesets' own `changeset publish` does not throttle -- publishing all 23
packages at once previously hit npm rate limits -- but its batch order is a
**hardcoded** 11-batch list in the script, not derived from the workspace
dependency graph. Keep any manual addition to that list in the same
dependency order as the table under `## Workspace structure and build
order` above; deriving it from the graph automatically is a tracked,
not-yet-done improvement (ecosystem-cohesion-plan.md section 2b), not
something to "fix" ad hoc in an unrelated change.
