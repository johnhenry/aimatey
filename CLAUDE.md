# aimatey — Development Guidelines

Universal AI Adapter System: a provider-agnostic interface for AI APIs.
Frontend adapters translate client formats (OpenAI, Anthropic, Gemini, Mistral, Ollama, Chrome AI)
into a universal Intermediate Representation (IR); the Bridge/Router core applies middleware,
routing strategies, circuit breaking, and fallback; backend adapters execute the IR against
30 provider APIs.

## Repository layout

- **Monorepo**: npm workspaces (`packages/*`) + Turbo + Changesets. 23 published packages.
- Key packages:
  - `packages/aimatey-types` — all type definitions, IR schema (`src/ir.ts`)
  - `packages/aimatey-core` — Bridge, Router, MiddlewareStack
  - `packages/aimatey-errors`, `packages/aimatey-utils` — errors and shared utilities
  - `packages/backend` (`@johnhenry/aimatey-backend`) — 30 backend provider adapters (subpath exports)
  - `packages/frontend` (`@johnhenry/aimatey-frontend`) — 7 frontend request-format adapters
  - `packages/middleware` — 10 middleware types (logging, caching, retry, cost tracking, …)
  - `packages/http.core` + `packages/http` — framework-agnostic HTTP handler + 6 framework adapters
  - `packages/react-core`, `react-hooks`, `react-nextjs`, `react-stream` — React integration
  - `packages/wrapper` — SDK-compatible wrappers; `packages/cli` — `ai-matey` CLI
  - `packages/native-*` — local model backends; `packages/aimatey-testing` — test utilities
- **Tests are centralized** in `/tests` (unit, core, http, integration suites via
  `vitest.workspace.ts`), not per-package.
- Dependency layering: `types` → `errors`/`utils` → `backend`/`frontend`/`core` → everything else.
  `@johnhenry/aimatey-utils` must not depend on core/backend. Frontend must not depend on backend.

## Commands

```bash
npm run build        # turbo build all packages (ESM + CJS + types)
npm test             # vitest run (all suites)
npm run lint         # turbo eslint; use `npx turbo run lint --force` to bypass cache
npm run typecheck
npm run changeset    # create a changeset for every user-facing change
```

Build before running integration tests that import built output. Zero runtime dependencies is a
core constraint — do not add npm dependencies to published packages (optional peer deps like `zod`
are the sanctioned exception).

## Conventions

- TypeScript strict mode; discriminated unions for IR chunk/message types.
- Semantic drift is tracked via `IRWarning` on request/response metadata — when a conversion is
  lossy or normalized, attach a warning rather than failing silently.
- Every user-facing change needs a changeset (`patch` = fix, `minor` = feature).
- Model data (pricing/context windows/aliases) lives in the model registry in `@johnhenry/aimatey-utils` —
  update the data file there rather than hardcoding model IDs elsewhere.
