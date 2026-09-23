# @johnhenry/aimatey-react-core

## 0.1.5

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-core@0.5.0
  - @johnhenry/aimatey-wrapper@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [9f1e9e5]
- Updated dependencies [c26ae12]
- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-core@0.4.0
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-wrapper@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [2ef419e]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-core@0.3.1
  - @johnhenry/aimatey-wrapper@0.1.3

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
  - @johnhenry/aimatey-wrapper@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-core@0.2.0
  - @johnhenry/aimatey-types@0.2.0
  - @johnhenry/aimatey-wrapper@0.1.1

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
  - @johnhenry/aimatey-types@0.1.0
  - @johnhenry/aimatey-wrapper@0.1.0

> Previously published as `aimatey-react.core`, last unscoped version `0.2.2`.

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
  - aimatey-core@0.3.3
  - aimatey-types@0.5.1
  - aimatey-wrapper@0.2.4

## 0.2.1

### Patch Changes

- f227db2: Lint hardening: previously-unlinted packages (cli, react-\*) now pass the strict ESLint config;
  fixed floating/misused promises in React hooks and CLI, case-block declarations, and unused
  variables. require-await and no-redundant-type-constituents re-enabled repo-wide.
- Updated dependencies [dae4d01]
- Updated dependencies [e7df1d0]
- Updated dependencies [f227db2]
- Updated dependencies [2912b7d]
- Updated dependencies [aef9f4a]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
  - aimatey-types@0.3.0
  - aimatey-core@0.3.0
