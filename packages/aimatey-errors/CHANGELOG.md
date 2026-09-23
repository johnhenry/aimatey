# @johnhenry/aimatey-errors

## 0.2.3

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0

## 0.2.2

### Patch Changes

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0

## 0.2.1

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [2ef419e]
  - @johnhenry/aimatey-types@0.4.0

## 0.2.0

### Minor Changes

- e800f3d: Classify `isRetryable` the same way everywhere.

  Four sites decided retryability and they disagreed, so the same fault was
  transient or permanent depending on which path reached it - and `isRetryable`
  is the only thing retry logic keys off.

  **`RouterError` derives `ALL_BACKENDS_FAILED` from its leaves, not from its
  code.** It asserted `isRetryable: options.code === ALL_BACKENDS_FAILED`, so a
  router whose every backend rejected the API key produced a "retryable" error
  and the caller burned its whole retry budget on a fault that was permanent at
  every leaf. `RouterErrorOptions` gains an optional `backendErrors`, and
  retryability is now `true` only when at least one attempted backend failed
  retryably - `some`, not `every`, because retrying helps as soon as one leg
  could succeed. This is the same principle as the `MiddlewareError` fix: a
  composite has no more standing to reclassify its parts than a wrapper has to
  reclassify its cause.

  **The router builds every `ALL_BACKENDS_FAILED` through `RouterError`.** There
  were four construction sites and three answers: `isRetryable: true` in parallel
  dispatch and parallel fallback, `false` on the embeddings and sequential
  fallback paths, none of them going through `RouterError`, which said `true` for
  all of them. All four now go through `RouterError`, which carries the leaf
  errors where they exist and derives one answer from them.

  **Neither retry implementation retries an unclassified error.** `Bridge`'s
  `config.retries` loop treated a non-`AdapterError` as retryable while
  `defaultShouldRetry` in `createRetryMiddleware` did not. `Bridge` now agrees
  with the middleware: an unclassified throwable is as likely a bug in the
  caller's own adapter or middleware as a transient fault, retrying it re-runs
  every middleware side effect for something that cannot succeed, and `Bridge`
  already wrapped such an error as a non-retryable `INTERNAL_ERROR` on the way
  out - so retrying it contradicted the classification it then handed the caller.

  **`408 Request Timeout` and `425 Too Early` are retryable.**
  `createErrorFromHttpResponse` had explicit branches for 401, 403, 429, 400 and
  5xx and fell through to `statusCode >= 500` for everything else, so the two
  statuses whose entire meaning is "try again" were marked permanent. `404`,
  `409` and `422` were checked and stay non-retryable: an identical retry
  reproduces each of them.

  Both flags are read duck-typed rather than through `instanceof AdapterError`,
  so a second copy of the errors package across the ESM/CJS boundary does not
  silently disable retries.

  **Behaviour changes.**
  - A `RouterError` built with `ALL_BACKENDS_FAILED` and no `backendErrors` is
    now non-retryable. If you construct one yourself and want the old answer,
    pass the failures it composes:

    ```ts
    new RouterError({
      code: ErrorCode.ALL_BACKENDS_FAILED,
      message: 'All backends failed',
      attemptedBackends: ['openai', 'anthropic'],
      backendErrors: [openaiError, anthropicError], // <- new
    });
    ```

  - `bridge.chat()` with `config.retries` no longer retries a backend failure
    that is not an `AdapterError` (or does not carry `isRetryable: true`). A
    backend that wants its failures retried should raise a classified error -
    `NetworkError`, `RateLimitError`, or an `AdapterError` with
    `isRetryable: true`.
  - The router's `ALL_BACKENDS_FAILED` errors are now `RouterError` instances
    rather than bare `AdapterError`s. `RouterError extends AdapterError` and the
    `code` is unchanged, so `instanceof AdapterError` and `error.code` checks are
    unaffected; only a check on `error.name === 'AdapterError'` would notice.

### Patch Changes

- f8d20bf: Stop middleware from reclassifying the errors it carries.

  `MiddlewareStack` re-labelled _every_ failure that passed through a middleware
  as a `MiddlewareError`, and `MiddlewareError` hard-coded `isRetryable: false`.
  A retryable `NetworkError` raised by the backend therefore reached the retry
  middleware already reclassified as permanent, and `createRetryMiddleware`
  stopped retrying as soon as any middleware was registered after it:

  ```ts
  bridge.use(createRetryMiddleware({ maxAttempts: 3 }));
  bridge.use(someOtherMiddleware); // <- retry now gives up after one attempt
  ```

  Retry configuration looked applied and was not; whether it worked depended
  purely on registration order. The same loss of classification reached
  everything downstream - `Bridge`'s own `config.retries` loop, `Router`'s
  `customFallback`, the HTTP status mapping (a backend `NetworkError` answered
  `500` instead of `502`), and any application-level retry, all of which were
  told a transient network failure was permanent.

  Two changes:
  - **`MiddlewareStack` (`@johnhenry/aimatey-core`)** now wraps only what a
    middleware raised _itself_ and left unclassified. An `AdapterError` already
    carries a code, a category and a retryability, so it propagates untouched;
    so does anything the final handler raised, which is a backend failure rather
    than a middleware failure. `MiddlewareError` is an `AdapterError`, so it is
    still re-thrown as-is.
  - **`MiddlewareError` (`@johnhenry/aimatey-errors`)** built around a `cause`
    now reports the cause's retryability instead of asserting `false`. Without a
    cause, or with a cause that carries no classification, it stays
    non-retryable.

  This also removes a divergence that had nothing to do with retry: with an empty
  stack a backend failure propagated raw, and registering a single middleware
  turned the same failure into a `MiddlewareError`. The error a caller sees no
  longer depends on how many middleware are registered.

  **Behaviour change for `@johnhenry/aimatey-core`.** Code that catches
  `MiddlewareError` to handle _backend_ failures behind a middleware chain now
  sees the original error class - `NetworkError`, `RateLimitError`,
  `ProviderError` - as it already did with no middleware registered. Catch
  `AdapterError` (the common base) or switch on `error.code` instead.
  `MiddlewareError` still means what its name says: a middleware itself failed.

- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [30629d4]
- Updated dependencies [eb8580b]
- Updated dependencies [e800f3d]
- Updated dependencies [582a4e5]
- Updated dependencies [71e5631]
  - @johnhenry/aimatey-types@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-types@0.2.0

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

> Previously published as `aimatey-errors`, last unscoped version `0.2.1`.

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
  - aimatey-types@0.5.1
