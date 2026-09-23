# @johnhenry/aimatey-http-core

## 0.3.2

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-core@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.3.1

### Patch Changes

- Updated dependencies [9f1e9e5]
- Updated dependencies [c26ae12]
- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-core@0.4.0
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-errors@0.2.2

## 0.3.0

### Minor Changes

- 8f9cd1c: Give `http.core` one error-to-status mapper instead of two that disagreed (#105).

  ## Two mappers, same package, different answers

  `handler.ts` and `error-handler.ts` each carried their own mapper, and they disagreed using
  a character-for-character identical predicate:

  ```ts
  // handler.ts:507
  if (message.includes('timeout')) return 408;
  // error-handler.ts:132
  if (message.includes('timeout')) return 504;
  ```

  Which status a caller saw for the same underlying timeout depended only on which code path
  handled it.

  ## The divergence was wider than the timeout

  Measuring both paths before the fix found eight disagreements, not one. `CoreHTTPHandler`'s
  private copy sniffed message text and ignored the typed error taxonomy **entirely**:

  | input                | handler.ts | error-handler.ts | now     |
  | -------------------- | ---------- | ---------------- | ------- |
  | message `timeout`    | 408        | 504              | **504** |
  | message `conflict`   | 409        | 500              | **409** |
  | message `validation` | 400        | 500              | **400** |
  | message `too large`  | 500        | 413              | **413** |
  | `RateLimitError`     | 500        | 429              | **429** |
  | `NetworkError`       | 500        | 502              | **502** |
  | `ProviderError`      | 500        | 503              | **503** |
  | `ValidationError`    | 500        | 400              | **400** |

  A rate limit surfacing through the handler path was reported as a generic 500 rather than a
  429, so a client could not tell it to back off. That is the more consequential half of this
  issue, and it was not visible from the reported symptom.

  ## What changed

  The mapper moved to a new `status-mapping.ts` that both files import -- one implementation,
  not two copies that can drift again. `error-handler.ts` re-exports `getHTTPStatusCode`, so
  the package's public API is unchanged, and `handler.ts`'s private duplicate is deleted.

  The unified mapper is the **union** of the two, so unifying dropped nothing: `conflict` and
  `validation` came from the handler's copy, `too large` and the typed taxonomy from the
  shared one.

  Timeout resolves to **504**. 408 says the client was too slow; 504 says an upstream was.
  This library proxies to a provider, so a timeout it observes is a gateway timeout.

  ## Retry behaviour did not diverge

  Worth stating because the issue raised it: no retry path keys off either status. The only
  status-driven retry predicate is `isRetryableStatusCode` in `@johnhenry/aimatey-errors`,
  whose sole caller is `createErrorFromHttpResponse` -- a mapper for responses _received from_
  a provider, the opposite direction from these two, which produce statuses the library
  _serves_. Every other retry decision (`Bridge`, the retry middleware, `Router`) reads the
  `isRetryable` boolean on the error object. And even where the two could meet -- an aimatey
  server proxied by an aimatey client -- 408 and 504 are both retryable anyway (408 is in
  `RETRYABLE_CLIENT_STATUS_CODES`; 504 is `>= 500`). So there was no silent retry split.

  ## Why this is `minor`

  Statuses served to callers change: a timeout through `CoreHTTPHandler` moves 408 -> 504, and
  the typed-error rows above move off 500. Any client keying on those codes sees different
  values. On 0.x that is a `minor`.

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [2ef419e]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-core@0.3.1
  - @johnhenry/aimatey-errors@0.2.1

## 0.2.0

### Minor Changes

- 7310960: Give the Node HTTP adapter real error handling: correct status codes, a response for
  oversized payloads, and no server internals on the wire.

  **A malformed request no longer reads as a server fault.** The Node listener's catch sent
  `sendError(res, err, 500)` — one hardcoded number for every failure. Unparseable JSON,
  which is entirely the caller's doing, came back as `500` with the message
  `Invalid JSON body: Expected property name or '}' in JSON at position 1`; so did a garbage
  `Host` header, which makes `new URL()` throw a bare `TypeError` inside `parseRequest()`.
  A client had no way to tell "fix your payload" from "the server is broken", and any retry
  policy keyed on 5xx would dutifully replay a request that could never succeed.

  The status now comes from `getHTTPStatusCode()`, the mapping that already existed in
  `error-handler.ts` but was module-private, so every HTTP entry point can reach the one
  taxonomy instead of hardcoding numbers at each catch site. It is now exported. The parser
  raises typed errors — `ValidationError` for unparseable JSON and for a `Host`/URL that
  cannot be parsed — so those map to `400` by class rather than by the accident of the word
  "invalid" appearing in a message.

  **An oversized body now gets a 413 instead of a dropped connection.** `readBody()` called
  `req.destroy()` the moment the size limit was crossed. That tears down the socket the
  response has to go out on, so the client received no status line at all — just a closed
  connection, indistinguishable from a crash or a network fault. It now stops buffering and
  keeps draining, which bounds memory the same way while leaving the response writable, and
  rejects with an error that declares `httpStatus: 413`. Declaring the status is what lets
  `getHTTPStatusCode()` answer 413 without inferring it from the word "large" in the message,
  which would break the first time someone reworded it. Errors may now carry
  `details.httpStatus` for exactly this purpose; it is read only from there, never from
  `httpContext.statusCode`, because that records what an upstream _provider_ answered and
  echoing it would report a provider's 404 as our own.

  **Error bodies no longer leak the server.** Every formatter — the two in
  `response-formatter.ts` and the copy in `CoreHTTPHandler` — put `error.message` straight in
  the response. A backend that failed with a message naming a source file handed the client
  that path verbatim. `sanitizeErrorMessage()` (also newly exported) now stands in front of
  all of them: 5xx becomes the canonical status text, since the caller can do nothing with
  the detail and the detail is what an attacker wants, while 4xx keeps its message — the only
  way a caller can correct the request — scrubbed of absolute paths, `file://` URLs, and
  appended stack frames. The full error is still reported server-side.

  **Server-side reporting follows the existing convention.** The listener called
  `console.error` directly, bypassing the `logging`/`log` options the core handler already
  honors, so a host that had configured a logger still got these errors on stderr. It now
  routes through `log` when logging is enabled and falls back to `console.error` only when
  nothing is configured.

  **Two smaller hardening changes.** A client that hangs up mid-request is recognised
  (`ECONNRESET`/`ECONNABORTED`/`EPIPE`, or Node's bare `Error: aborted`) and logged rather
  than run through the error responder, which would only fail a second time writing to a dead
  socket. And `req.setTimeout()`/`res.setTimeout()` moved inside the `try`: they sat above it,
  where a bad `timeout` value would reject the handler promise that `http.Server` never
  awaits — an unhandled rejection, fatal on Node >= 15, which is the failure this whole area
  is supposed to prevent.

  Covered by tests that drive a real `http.Server` over real sockets. The existing listener
  suite builds mock `req`/`res` objects, and a mock never destroys a socket, aborts mid-body,
  or reports `headersSent` — which is why these failure modes survived it. Each new test
  asserts both the status code and that the server is still serving afterwards.

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
  - @johnhenry/aimatey-errors@0.2.0

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

> Previously published as `aimatey-http.core`, last unscoped version `0.3.1`.

## 0.3.1

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

## 0.3.0

### Minor Changes

- d3fd2e2: Production HTTP endpoints: built-in `/health` + `/health/ready` + `/health/live`, Prometheus
  `/metrics`, OpenAI-compatible `/v1/embeddings`, per-route rate limits via `RouteConfig.rateLimit`,
  and a zero-dependency WebSocket streaming subpath (`aimatey-http/websocket`).
- 78731bb: Router emits `model-substituted` warnings (metadata + new `RouterConfig.onWarning` callback) when
  hybrid translation falls back to a backend default model. http.core gains a framework-agnostic
  `GenericRateLimiter`; `RouteMatcher.match()` accepts any structurally-compatible request.

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
