# @johnhenry/aimatey-testing

## 0.2.0

### Minor Changes

- b74fe24: Add `createMockDecisionBackend(config)`: a decision-only mock backend taking `{ answers?, handler?, latencyMs?, error?, name?, model? }` and exposing a `calls` log of every `IRDecisionRequest` it received. Exports the `MockDecisionBackend` and `MockDecisionBackendConfig` types.
- af22382: Decision calibration and bias checks (#147): `calibrationReport` (Brier, ECE, ten reliability buckets), `fitTemperature` (the temperature to give `createTemperatureScaling`), and `nameInvariance` (runs a request as written, with neutral keys, and with names reassigned to other definitions, and reports how often the answer followed the name).
- cee0de7: Decision dataset capture: `createDecisionCapture({ sink, includeState?, redact? })` records every `Bridge.decide()` as JSONL (state, questions, answers, model, usage, warnings) and `recordOutcome(requestId, truth)` appends ground truth, joined on read. Also `loadDecisionDataset(path)`, `toCalibrationRuns(records)`, and memory/file sinks. This is the capture half of a fine-tuning loop; nothing here trains.
- ce029c0: New Vitest-free `@johnhenry/aimatey-testing/decisions` subpath export (`calibrationReport`, `fitTemperature`, `nameInvariance`, and the decision dataset capture helpers) so CLIs can import them outside a test run. The root export still re-exports them.

### Patch Changes

- 88df633: `calibrationReport` now takes the predicted probability of being right from `probabilities` (the mass on the answer's own label for `choice`, on the rounded level for `score`, `max(value, 1 - value)` for `noul`) instead of `answer.confidence`, which is a concentration measure rather than P(correct). `confidence` is used only when a `choice` / `score` answer has no `probabilities`. Bucket `meanConfidence` and ECE change accordingly.
- Updated dependencies [291c3a5]
- Updated dependencies [291c3a5]
- Updated dependencies [f787563]
- Updated dependencies [bb94242]
- Updated dependencies [3a3c98b]
- Updated dependencies [3a3c98b]
- Updated dependencies [ce029c0]
- Updated dependencies [b74fe24]
- Updated dependencies [e853983]
- Updated dependencies [e853983]
- Updated dependencies [5936850]
- Updated dependencies [07d9bc7]
- Updated dependencies [07d9bc7]
- Updated dependencies [af22382]
- Updated dependencies [cee0de7]
- Updated dependencies [c115285]
- Updated dependencies [88ce5c7]
- Updated dependencies [88ce5c7]
- Updated dependencies [59f7fbe]
- Updated dependencies [d28c9a8]
- Updated dependencies [e501444]
  - @johnhenry/aimatey-types@0.7.0
  - @johnhenry/aimatey-utils@0.6.0

## 0.1.5

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0

## 0.1.4

### Patch Changes

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-utils@0.4.0

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

## 0.1.2

### Patch Changes

- 9fd19f4: Fix package readmes that documented APIs which do not exist (#61).

  These readmes ship in the published tarball (`files: ["dist", "readme.md", ...]`),
  so the wrong examples reached npm:
  - `@johnhenry/aimatey-middleware`: the quick-start built a bridge with
    `new Bridge({ frontend, backend, middleware: [...] })`. `Bridge` takes
    positional arguments and `BridgeConfig` has no `middleware` field, so that
    snippet produced a bridge with **no middleware, silently** - the same
    fail-quiet mode as #46, reached by following the readme. Middleware is
    registered with `bridge.use()`. Also corrected `initialDelayMs`/`maxDelayMs`
    to `initialDelay`/`maxDelay`, `ttlMs` to `ttl`, and `detectPromptInjection`
    to `preventPromptInjection`.
  - `@johnhenry/aimatey-frontend` and `@johnhenry/aimatey-http`: the same
    `new Bridge({ frontend, backend })` object form, corrected to the real
    positional constructor.
  - `@johnhenry/aimatey-http-core`: the entire quick-start and API reference
    described `createCorsMiddleware`, `validateApiKey` and `parseRequestBody`,
    none of which exist. Replaced with the real `CoreHTTPHandler` class and its
    `CoreHandlerOptions`.
  - `@johnhenry/aimatey-testing`: listed `MockBackendAdapter`, `createMockResponse`
    and `assertChatRequest` as its exports; none exist in this package. Replaced
    with the real fixture / assertion / property-testing surface, and a pointer to
    `MockBackendAdapter` in `@johnhenry/aimatey-backend-browser/mock`.
  - `@johnhenry/aimatey-utils`: documented `asyncGeneratorToReadableStream` and
    `readableStreamToAsyncGenerator`, which do not exist. Replaced with the real
    `splitStream` / `teeStream` helpers.
  - `@johnhenry/aimatey-react-core`: `OpenAIBackend` -> `OpenAIBackendAdapter`.

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

## 0.1.1

### Patch Changes

- bc0b9ea: Import Node builtins with the `node:` prefix.

  Follow-up to #48, where a bare `'crypto'` specifier in the middleware package
  was mistaken for a browser-safe import. These packages are server-only, so the
  bare form was not a runtime bug, but it is ambiguous with an npm package of the
  same name and it hides Node-only code from review. Affected specifiers:
  `'crypto'`/`'http'` in `@johnhenry/aimatey-http-core`, `'http'` in
  `@johnhenry/aimatey-http`, and `'fs/promises'`/`'path'` in
  `@johnhenry/aimatey-testing`. `timingSafeEqual` in `http.core`'s auth validator
  stays on Node crypto — it is genuinely security-relevant and that package never
  runs in a browser.

  No behavioural change: `'x'` and `'node:x'` resolve to the same builtin in every
  supported Node version.

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-types@0.2.0
  - @johnhenry/aimatey-utils@0.1.1

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

> Previously published as `aimatey-testing`, last unscoped version `0.2.2`.

## 0.2.2

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
  - aimatey-types@0.5.1
  - aimatey-utils@0.4.2

## 0.2.1

### Patch Changes

- f227db2: Lint hardening: previously-unlinted packages (cli, react-\*) now pass the strict ESLint config;
  fixed floating/misused promises in React hooks and CLI, case-block declarations, and unused
  variables. require-await and no-redundant-type-constituents re-enabled repo-wide.
- Updated dependencies [dae4d01]
- Updated dependencies [e7df1d0]
- Updated dependencies [2912b7d]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
- Updated dependencies [58ebc03]
  - aimatey-types@0.3.0
  - aimatey-utils@0.3.0
