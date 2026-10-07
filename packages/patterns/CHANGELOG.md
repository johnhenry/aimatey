# @johnhenry/aimatey-patterns

## 0.2.0

### Minor Changes

- 3a3c98b: `createEmulatedDecisionBackend` now coerces near-miss chat-model answers instead of rejecting them: `"true"`/`"false"` (any case) or `1`/`0` for `noul`, numeric strings for `score` indices, and a trimmed, case-insensitive match for `choice` keys and score labels (exact matches win). Each coercion adds a `response-malformed` warning. `createDecisionEscalation` gains `onUnmatchable?: 'throw' | 'skip'` (default `'throw'`); `'skip'` treats a leaf that cannot apply to the request's question types as not matched instead of throwing, and `validateDecisionCondition` takes the same option. Temperature scaling, ensembles, neutral option keys and `decisionBands` now compute `confidence` with the shared `decisionConfidence` / `noulConfidence`, so a computed `noul` confidence is the concentration of `[p, 1 - p]` rather than `max(p, 1 - p)`.
- 5936850: Add `createEmulatedDecisionBackend(chatBackend, opts?)`: wraps any chat backend as a decision backend that answers `choice` / `score` / `noul` questions in one structured-output chat call (schema generated from the questions; `includeReasoning` populates `answer.reasoning`). It is opt-in, never applied by `Bridge` or `Router`, and returns **no** `probabilities` or `confidence`: it does not fake a distribution. Every response carries a `capability-emulated` warning and the adapter declares `decisionsEmulated: true`. An answer outside its enum rejects with a `ProviderError` naming the question.
- af22382: Decision patterns (#147), each a default-off factory: `createDecisionEscalation` (Vercel's `when` contract; reruns the whole request on a fallback, sums both stages' usage, records `metadata.custom.escalation`) with `evaluateDecisionCondition`, `validateDecisionCondition` and `decisionBands`; `createNeutralOptionKeys` (opt_1..n keys with the name folded into the description, optional seeded shuffle and `noulAsChoice`); `createDecisionEnsemble` (parallel members, mean/median/custom aggregation, agreement-aware confidence, intersected capabilities); `createStateScreening` (delimits untrusted state and optionally screens it with a noul question before the model); and `createTemperatureScaling` (per-type / per-option-count temperature). `createEmulatedDecisionBackend` now warns with the new `capability-emulated` category instead of `capability-unsupported`.

### Patch Changes

- 88df633: Declare the `@johnhenry/aimatey-utils` dependency both packages already import. It resolved only through workspace hoisting, so a published install could fail.
- Updated dependencies [291c3a5]
- Updated dependencies [291c3a5]
- Updated dependencies [291c3a5]
- Updated dependencies [f787563]
- Updated dependencies [bb94242]
- Updated dependencies [3a3c98b]
- Updated dependencies [3a3c98b]
- Updated dependencies [ce029c0]
- Updated dependencies [ce029c0]
- Updated dependencies [b74fe24]
- Updated dependencies [e853983]
- Updated dependencies [e853983]
- Updated dependencies [e853983]
- Updated dependencies [5936850]
- Updated dependencies [07d9bc7]
- Updated dependencies [07d9bc7]
- Updated dependencies [07d9bc7]
- Updated dependencies [af22382]
- Updated dependencies [cee0de7]
- Updated dependencies [cee0de7]
- Updated dependencies [c115285]
- Updated dependencies [88ce5c7]
- Updated dependencies [88ce5c7]
- Updated dependencies [59f7fbe]
- Updated dependencies [d28c9a8]
- Updated dependencies [e501444]
  - @johnhenry/aimatey-core@0.6.0
  - @johnhenry/aimatey-types@0.7.0
  - @johnhenry/aimatey-utils@0.6.0
  - @johnhenry/aimatey-errors@0.3.0

## 0.1.5

### Patch Changes

- 22dc8ca: Add a typed-decision capability, sibling to chat and embeddings, plus a backend/frontend adapter pair for TypeSafe's Jev.

  A typed-decision request ("System One" models: TypeSafe's Jev, ConvAI's Laya) sends a state and a set of typed questions (`choice`/`score`/`noul`) and gets back typed answers with calibrated probabilities in a single forward pass -- no generated text, nothing to parse. This is not a chat variant: it has its own IR (`IRDecisionRequest`/`IRDecisionResponse` in `decisions.ts`, mirroring `embeddings.ts`), its own `Bridge.decide()`/`useDecision()` entry point, and its own capability flags (`IRCapabilities.decisions`/`decisionModels`).

  **Breaking-adjacent, but backward compatible for every existing implementer:** `BackendAdapter.fromIR`/`toIR`/`execute`/`executeStream` are now optional. A decision-only backend (like the new `TypeSafeBackendAdapter`) implements only `metadata` and `decide()` -- it is not forced to fake a chat capability it doesn't have. Every existing chat backend still implements all four; nothing changes for it. `Bridge`/`Router`/the SDK wrappers (`packages/wrapper`) and the CLI's `ollama run`/proxy server now check for chat support up front and throw a clear `UNSUPPORTED_FEATURE` error if a decision-only backend is used somewhere that requires chat, instead of a raw "not a function" crash.

  New: `TypeSafeBackendAdapter` (`packages/backend/src/providers/typesafe.ts`) calling Jev's real `/systemone` API, and `TypeSafeFrontendAdapter` (`packages/frontend/src/adapters/typesafe.ts`) translating `@typesafe-ai/sdk`-shaped `systemOne()` calls into the Decision IR -- deliberately not an implementation of the (chat-typed) `FrontendAdapter` interface, since a decision request isn't a chat request in a costume.

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-core@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.1.4

### Patch Changes

- Updated dependencies [9f1e9e5]
- Updated dependencies [c26ae12]
- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-core@0.4.0
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-errors@0.2.2

## 0.1.3

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [2ef419e]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-core@0.3.1
  - @johnhenry/aimatey-errors@0.2.1

## 0.1.2

### Patch Changes

- Updated dependencies [48c5c26]
- Updated dependencies [7be8792]
- Updated dependencies [223c37a]
- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [30629d4]
- Updated dependencies [f8d20bf]
- Updated dependencies [eb8580b]
- Updated dependencies [9b31fc4]
- Updated dependencies [8b89edb]
- Updated dependencies [e800f3d]
- Updated dependencies [582a4e5]
- Updated dependencies [c06df51]
- Updated dependencies [71e5631]
  - @johnhenry/aimatey-core@0.3.0
  - @johnhenry/aimatey-types@0.3.0
  - @johnhenry/aimatey-errors@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-core@0.2.0
  - @johnhenry/aimatey-types@0.2.0
  - @johnhenry/aimatey-errors@0.1.1

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
  - @johnhenry/aimatey-core@0.1.0
  - @johnhenry/aimatey-errors@0.1.0
  - @johnhenry/aimatey-types@0.1.0

> Previously published as `aimatey-patterns`, last unscoped version `0.2.1`.

## 0.2.1

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
  - aimatey-core@0.3.3
  - aimatey-errors@0.2.1
  - aimatey-types@0.5.1

## 0.2.0

### Minor Changes

- aef9f4a: New `aimatey-patterns` package: complexity routing, parallel aggregation, failover middleware,
  cost optimization with budget windows, and batch processing. Router's `dispatchParallel` now
  actually honors the `fastest` strategy (previously returned the first-registered success).

### Patch Changes

- Updated dependencies [dae4d01]
- Updated dependencies [e7df1d0]
- Updated dependencies [f227db2]
- Updated dependencies [2912b7d]
- Updated dependencies [aef9f4a]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
  - aimatey-types@0.3.0
  - aimatey-core@0.3.0
