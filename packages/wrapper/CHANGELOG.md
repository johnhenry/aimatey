# @johnhenry/aimatey-wrapper

## 0.1.5

### Patch Changes

- 22dc8ca: Add a typed-decision capability, sibling to chat and embeddings, plus a backend/frontend adapter pair for TypeSafe's Jev.

  A typed-decision request ("System One" models: TypeSafe's Jev, ConvAI's Laya) sends a state and a set of typed questions (`choice`/`score`/`noul`) and gets back typed answers with calibrated probabilities in a single forward pass -- no generated text, nothing to parse. This is not a chat variant: it has its own IR (`IRDecisionRequest`/`IRDecisionResponse` in `decisions.ts`, mirroring `embeddings.ts`), its own `Bridge.decide()`/`useDecision()` entry point, and its own capability flags (`IRCapabilities.decisions`/`decisionModels`).

  **Breaking-adjacent, but backward compatible for every existing implementer:** `BackendAdapter.fromIR`/`toIR`/`execute`/`executeStream` are now optional. A decision-only backend (like the new `TypeSafeBackendAdapter`) implements only `metadata` and `decide()` -- it is not forced to fake a chat capability it doesn't have. Every existing chat backend still implements all four; nothing changes for it. `Bridge`/`Router`/the SDK wrappers (`packages/wrapper`) and the CLI's `ollama run`/proxy server now check for chat support up front and throw a clear `UNSUPPORTED_FEATURE` error if a decision-only backend is used somewhere that requires chat, instead of a raw "not a function" crash.

  New: `TypeSafeBackendAdapter` (`packages/backend/src/providers/typesafe.ts`) calling Jev's real `/systemone` API, and `TypeSafeFrontendAdapter` (`packages/frontend/src/adapters/typesafe.ts`) translating `@typesafe-ai/sdk`-shaped `systemOne()` calls into the Decision IR -- deliberately not an implementation of the (chat-typed) `FrontendAdapter` interface, since a decision request isn't a chat request in a costume.

- Updated dependencies [6f5e0a9]
- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-frontend@0.3.0
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.1.4

### Patch Changes

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-utils@0.4.0
  - @johnhenry/aimatey-frontend@0.2.1

## 0.1.3

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [9ac5666]
- Updated dependencies [2ef419e]
- Updated dependencies [5596299]
- Updated dependencies [5596299]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-utils@0.3.0
  - @johnhenry/aimatey-frontend@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [22b9273]
- Updated dependencies [32415cc]
- Updated dependencies [30629d4]
- Updated dependencies [eb8580b]
- Updated dependencies [9fd19f4]
- Updated dependencies [8b89edb]
- Updated dependencies [e800f3d]
- Updated dependencies [582a4e5]
- Updated dependencies [71e5631]
- Updated dependencies [0abfa0b]
- Updated dependencies [bb69513]
  - @johnhenry/aimatey-types@0.3.0
  - @johnhenry/aimatey-utils@0.2.0
  - @johnhenry/aimatey-frontend@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-types@0.2.0
  - @johnhenry/aimatey-utils@0.1.1
  - @johnhenry/aimatey-frontend@0.1.1

## 0.1.0

### Minor Changes

- Republish from current main with a real fresh build.

  The 0.0.0 scope-import publishes (2026-08-26) shipped stale dist output --
  local npm publish without a rebuild, so the tarballs were missing everything
  after mid-July: the OmniRoute/GitHub Models/DashScope/Moonshot/SambaNova/
  Inception providers, litert-lm, the embeddings types module, and the
  provider-default-model fixes. This release republishes every package from
  current main (which also includes the 2026-08-26 audit fixes) via the CI
  release workflow, which always builds fresh before publishing.

### Patch Changes

- Updated dependencies
  - @johnhenry/aimatey-types@0.1.0
  - @johnhenry/aimatey-utils@0.1.0
  - @johnhenry/aimatey-frontend@0.1.0

> Previously published as `aimatey-wrapper`, last unscoped version `0.2.4`.

## 0.2.4

### Patch Changes

- 73aa9f1: Fix broken CJS entry points across the whole package family. Every package declares
  `"type": "module"` for ESM subpath resolution, but shipped `dist/cjs/` builds with no nested
  override - Node walked up to the package root, saw `"type": "module"`, and misinterpreted the
  compiled CommonJS as ESM, so `require("aimatey-x")` failed with `Cannot find module './y.js'`
  on every package in the family (ESM `import` was unaffected). Each package's build now emits a
  `dist/cjs/package.json` containing `{"type":"commonjs"}` (via a new
  `scripts/fix-cjs-package-json.js` post-build step) to correctly scope the CJS build's module
  type. No source or `exports` map changes - verified via `npm pack` + fresh install against the
  exact repro in #23, both direct `require()` and the `require` export condition on subpaths (e.g.
  `aimatey-backend.browser/chrome-ai`).

  (#23)

- Updated dependencies [73aa9f1]
  - aimatey-frontend@0.4.1
  - aimatey-types@0.5.1
  - aimatey-utils@0.4.2

## 0.2.3

### Patch Changes

- Streaming methods now check `AbortSignal` between chunks in Bridge, Router, and the chat wrapper,
  so aborting a request stops delivery promptly instead of draining the remaining stream. (#8)
