# @johnhenry/aimatey-core

## 0.5.0

### Minor Changes

- 22dc8ca: Add a typed-decision capability, sibling to chat and embeddings, plus a backend/frontend adapter pair for TypeSafe's Jev.

  A typed-decision request ("System One" models: TypeSafe's Jev, ConvAI's Laya) sends a state and a set of typed questions (`choice`/`score`/`noul`) and gets back typed answers with calibrated probabilities in a single forward pass -- no generated text, nothing to parse. This is not a chat variant: it has its own IR (`IRDecisionRequest`/`IRDecisionResponse` in `decisions.ts`, mirroring `embeddings.ts`), its own `Bridge.decide()`/`useDecision()` entry point, and its own capability flags (`IRCapabilities.decisions`/`decisionModels`).

  **Breaking-adjacent, but backward compatible for every existing implementer:** `BackendAdapter.fromIR`/`toIR`/`execute`/`executeStream` are now optional. A decision-only backend (like the new `TypeSafeBackendAdapter`) implements only `metadata` and `decide()` -- it is not forced to fake a chat capability it doesn't have. Every existing chat backend still implements all four; nothing changes for it. `Bridge`/`Router`/the SDK wrappers (`packages/wrapper`) and the CLI's `ollama run`/proxy server now check for chat support up front and throw a clear `UNSUPPORTED_FEATURE` error if a decision-only backend is used somewhere that requires chat, instead of a raw "not a function" crash.

  New: `TypeSafeBackendAdapter` (`packages/backend/src/providers/typesafe.ts`) calling Jev's real `/systemone` API, and `TypeSafeFrontendAdapter` (`packages/frontend/src/adapters/typesafe.ts`) translating `@typesafe-ai/sdk`-shaped `systemOne()` calls into the Decision IR -- deliberately not an implementation of the (chat-typed) `FrontendAdapter` interface, since a decision request isn't a chat request in a costume.

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.4.0

### Minor Changes

- c26ae12: Make `Router.isBackendAvailable()` public (#134).

  `isBackendAvailable(name)` was `private` while `isCircuitBreakerOpen(name)` was public, so a
  caller wanting to pre-flight "will this actually go where I asked?" could see the circuit half
  of the predicate but not the health half, and had to approximate the rest:

  ```ts
  // what was reachable                    // what routing actually asks
  !router.isCircuitBreakerOpen(name)       state.isHealthy && state.circuitBreakerState !== 'open'
  ```

  A backend that failed its last health check is unhealthy and will not be routed to even though
  its circuit is closed, so the approximation is wrong in exactly the case a caller cares about.

  The method is now public on the `Router` class and declared on the `Router` interface in
  `@johnhenry/aimatey-types`. Behaviour is unchanged — this only widens visibility.

### Patch Changes

- 9f1e9e5: Cancel a circuit breaker's pending half-open transition when the breaker it belongs to goes away.

  `Router.openCircuitBreaker()` schedules the `open -> half-open` transition with a `setTimeout`
  and then dropped the handle on the floor. Nothing held it, so nothing could cancel it, and the
  timer outlived both the open it was scheduled for and, in one case, the backend it named.

  ## A rest period could be cut short by a timer from an earlier one

  The scheduled callback carries no record of which open it belongs to. It half-opens whatever
  open the breaker happens to be in when it arrives:

  ```ts
  router.openCircuitBreaker('peer'); // t=0    rest until t=30s
  router.openCircuitBreaker('peer'); // t=20s  rest until t=50s
  // t=30s  the t=0 timer fires -> half-open
  ```

  The second rest period was configured for 30 seconds and lasted 10. A half-open breaker is not
  refused by `checkCircuitBreaker`, so a trial request reaches a backend 20 seconds before the
  caller said it should — on a backend that is, by the router's own accounting, still failing.

  The same shape reaches the two lifecycle methods that close a breaker as part of their contract:
  - `closeCircuitBreaker()` / `resetCircuitBreaker()` left the transition armed, so a breaker
    closed by hand and later reopened inherited the old timer.
  - `replace()` documents that it resets the health verdict precisely so a breaker tripped by an
    expired credential cannot keep refusing the new, working one. It reset the verdict and left
    the old verdict's timer running — so if the replacement backend then failed too, its rest
    period was the one cut short.

  ## A transition could outlive its backend

  `unregister()` deleted the map entry and left the timer armed. Until it expired, the callback
  held the removed `BackendState` — and through it the adapter — keeping both reachable after the
  router had dropped them, and keeping the host's event loop alive on a backend that no longer
  exists. For a caller unregistering a backend in order to revoke it, the last reference to the
  revoked adapter survived the revocation by up to `circuitBreakerTimeout`.

  ## The rule

  A breaker that stops being the open breaker a timer was scheduled for cancels that timer:
  `openCircuitBreaker` (cancels the earlier one before arming its own), `closeCircuitBreaker`,
  `resetCircuitBreaker`, `replace` and `unregister`.

  No signature, type or configuration changes. The normal path is unchanged: a breaker left alone
  still half-opens exactly `circuitBreakerTimeout` after it opened.

- c26ae12: Honour `fallbackStrategy: 'none'` at selection time, not only after a failure (#134).

  ## The defect

  `FallbackStrategy.NONE` is documented as "No fallback - fail immediately if primary backend
  fails". A caller pairing it with `routingStrategy: 'explicit'` is asking for one thing: **this
  backend, or nothing.** The Router did not deliver that.

  `fallbackStrategy` was consulted on every _post-failure_ path — `execute()`'s catch,
  `executeEmbed()`, `executeFallback()`, `nextStreamFallbackBackend()` — but never inside
  `selectBackend()`. So an open circuit took a different route entirely:

  ```
  isBackendAvailable('primary')  ->  false   (circuitBreakerState === 'open')
  routeExplicit('primary')       ->  null
  // ...falls through to:
  // Final fallback: first available backend
  if (!selectedBackend) {
    selectedBackend = this.getAvailableBackends()[0] ?? null;   // <- unguarded
  }
  ```

  Nothing guarded that branch — not `routingStrategy: 'explicit'`, not `fallbackStrategy:
'none'`. Which backend answered was **registration order**. The request never "failed", so no
  failure path ever ran, and the caller was told nothing: `execute()` returned a normal response
  and `executeStream()` produced an ordinary `[content, done]` stream.

  The distinction the code was drawing is _failure_ vs _unavailability_, and the option only
  covered the first. From the caller's side both are fallback — the request went somewhere they
  did not name. Reported from a privacy-first on-device app, where a turn targeted at a local
  model was answered by a cloud provider once the local backend's breaker opened.

  ## The fix

  A named preference that cannot be honoured is a **substitution**, and `'none'` is the opt-out
  from substitution:

  ```ts
  const refusesSubstitution =
    this.config.fallbackStrategy === 'none' && preferredBackend !== undefined;

  if (!selectedBackend && !refusesSubstitution) {
    /* first available */
  }
  ```

  `selectedBackend` stays null and the existing `NO_BACKEND_AVAILABLE` throw fires — which is
  what "fail immediately" already promised. `executeStream()` surfaces it as an error chunk, its
  established shape for a failure it cannot fail over.

  The guard is limited to a **named** preference. When the caller named nothing there is no
  substitution to refuse: that branch is simply how a router without a `defaultBackend` resolves
  at all, and suppressing it there would leave a single-backend `'none'` router unable to route
  anything — a much larger break than the bug.

  ## Not changed

  Every other `fallbackStrategy` is untouched: with the default `'sequential'` an open circuit
  still substitutes at selection time, exactly as before.

  `routingStrategy: 'explicit'` still permits the substitution on its own. It reads like a
  contradiction, but `routingStrategy` **defaults** to `'explicit'`, so guarding on it would
  silently re-aim every router that never configured routing at all, and would reroute those
  requests through the post-failure fallback machinery — changing `totalFallbacks` accounting for
  successful requests. `fallbackStrategy: 'none'` is the documented opt-out and is what #134 is
  about.

- 305af90: Give `sequence` a contract and make every adapter keep it, and let a warning say the
  delivery was degraded rather than the translation (#120, #123, #131).

  ## `sequence` had no contract, and 27 adapters broke the one it turned out to have

  `BaseStreamChunk.sequence` shipped with no doc comment at all. Nothing said whether it
  starts at 0, whether it increments by one, whether a `metadata` chunk between two `content`
  chunks consumes a number, or what a consumer should do on a gap. In-process none of that
  matters: an async generator cannot drop or reorder its own yields, so the field is
  decoration. Across a wire it is the only loss-detection primitive the IR has, and a gap can
  only mean loss if a gap is illegal.

  It is now documented as **monotonic and contiguous from 0, across all chunk types of one
  stream**. That is not a new rule -- it is the rule `validateChunkSequence()` and
  `validateStream()` in `@johnhenry/aimatey-utils` have always enforced. It was simply never
  written down, so nothing checked that the library's own adapters obeyed it.

  They did not. Every streaming adapter emitted its terminal `error` chunk from a `catch` that
  could not see the counter, so it hardcoded `sequence: 0`:

  ```ts
  } catch (error) {
    yield { type: 'error', sequence: 0, ... };   // after 40 content chunks
  }
  ```

  A provider failing part-way through a generation therefore produced `0, 1, 2, … 40, 0` --
  a duplicate and a decrease in the one place a consumer most needs to trust the numbering.
  Passed through this repo's own strict `validateStream()`, that stream throws
  `Out-of-order chunk: sequence 0 after 41`, replacing the provider's real error with a
  validator artefact. A consumer using `sequence` to detect a severed connection sees a reset
  instead.

  Fixed in all 27 emitters -- 22 HTTP providers, `chrome-ai`, `litert-lm`, `native-apple`,
  `native-model-runner` and `native-node-llamacpp` -- by hoisting the counter above the `try`.
  `native-model-runner`, which delegates with `yield*`, now tracks the delegated stream's
  numbering so its own terminal chunk continues it.

  `Router.executeStream` had the same fault twice over. Its synthesized error chunk was
  numbered 0 after it had already delivered a committed stream's chunks; and a _backend's_
  error chunk was forwarded with the number the backend gave it, even though the router may
  have withheld that backend's preamble or failed over from it -- opening a stream at
  `sequence: 3` with nothing before it. The terminal chunk is now renumbered onto the stream
  the consumer actually received.

  ## `WarningCategory` could not say a turn was served badly

  All thirteen existing members describe a **translation** problem: a parameter normalized or
  clamped, a capability missing, content redacted, a model substituted. Coherent, and with no
  room for a turn that was translated faithfully and then _delivered_ badly. The only thing to
  reach for was `capability-unsupported`, which says the backend could not do what was asked
  -- a different claim, and one that stops carrying information after a few stretches.

  Three additive members, and a factory for each in `@johnhenry/aimatey-utils`:
  - **`request-queued`** -- a store-and-forward transport held the request and ran it later.
    `createRequestQueuedWarning(queuedMs, source)`; the wait goes in `details`, because a
    caller that has already shown a spinner needs the elapsed time and not just the fact.
  - **`transport-degraded`** -- the link degraded the turn: a stream that reconnected
    mid-response, a re-send after a transport failure, a hop an order of magnitude slower than
    the same request served locally. `createTransportDegradedWarning(reason, { details, source })`.
  - **`provenance-lost`** -- a response arrived where the receiver had reason to expect
    `IRMetadata.provenance` and there was none. `createProvenanceLostWarning(expectedFrom, source)`.

  The last one closes a gap that only exists across a wire. `provenance` is optional, so
  `undefined` means both "the chain recorded nothing" and "the chain recorded something and
  the trip ate it" -- dropped by a transport, a re-serialization, or a hop that rebuilt
  `metadata` without spreading the old one. In one process the second never happens; across a
  boundary it is the difference between "we do not know where this ran" and "something ate the
  answer", and an application whose rule is that unknown provenance renders as _no_ trust label
  needs "unknown" to stay rare and honest.

  It is the **receiving hop's claim about what it expected**, never an inference by a walker
  and never attached by an adapter that had no such expectation -- so an absent provenance
  carrying no `provenance-lost` warning still means "not recorded", exactly as before.

  Adding members to a union is additive for producers. Consumers that switch exhaustively on
  `WarningCategory` will need the usual new-member arms.

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-utils@0.4.0
  - @johnhenry/aimatey-errors@0.2.2

## 0.3.1

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [9ac5666]
- Updated dependencies [2ef419e]
- Updated dependencies [5596299]
- Updated dependencies [5596299]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-utils@0.3.0
  - @johnhenry/aimatey-errors@0.2.1

## 0.3.0

### Minor Changes

- 3467132: Scope cache entries to a caller, and stop caching requests that name none.

  `createCachingMiddleware`'s default key was a hash of model, messages and parameters, and
  `createEmbeddingCachingMiddleware`'s of input, model and parameters. Neither had any notion
  of who was asking. One process answering for several users therefore had a single cache
  bucket shared by all of them: the second user to send a prompt was handed the first user's
  completion. That is a disclosure bug wearing a performance bug's clothes, and nothing in
  the API made it visible - a caller who configured caching and nothing else got it (#44).

  A `scopeKey` option was added in #45 so a deployment _could_ scope entries by tenant. It
  had to be opted into, which is the wrong way round for this failure mode: the deployment
  that never heard of the option is exactly the one that is leaking.

  **Identity is now a first-class IR field.** `IRMetadata.principal` is an opaque,
  deployment-defined string - a tenant ID, a user ID, an API-key fingerprint, a composite
  like `tenant-7:user-42`. It is compared verbatim, never parsed, and never sent to a
  provider. `Bridge.chat()`, `chatStream()` and `embed()` set it from a typed request option:

  ```typescript
  await bridge.chat(request, { principal: `tenant-${tenantId}:user-${userId}` });
  ```

  It is deliberately not a convention inside `metadata.custom`. `custom` is an unstructured
  bag whose keys mean whatever an application decided they mean, so no middleware can read
  identity out of it safely; scoping that exists to keep users apart needs a field with one
  defined meaning. (The previous documentation suggested `metadata.custom.tenantId`, which
  worked only because you wrote both halves of the convention yourself.)

  **The default is now to cache less.** The cache key mixes in a scope taken from `scopeKey`
  if set, otherwise from `metadata.principal`. A request with neither is not cached at all:
  it goes to the backend, the response comes back with a `cache-bypassed` warning on
  `metadata.warnings` and `metadata.custom.cacheBypassed === true`, and nothing is written.
  Nothing written is nothing that can later be read by the wrong caller.

  The alternative default - keep sharing, and warn - was rejected. The two failure modes are
  not symmetric: defaulting to sharing discloses one user's completion to another and does so
  silently, while defaulting to bypassing costs cache hits until somebody sets one option and
  says so in a warning on every response. The expensive mistake is the recoverable one.

  **Single-tenant deployments say so once.** One process, one audience, every entry safe to
  share - that is why caching was switched on, and it keeps working:

  ```typescript
  bridge.use(createCachingMiddleware({ ttl: 3_600_000, unidentified: 'share' }));
  ```

  `unidentified: 'share'` restores the pre-#44 behaviour for requests that carry no identity.
  Requests that _do_ carry a principal stay scoped to it even in this mode.

  **Existing cache entries survive.** The scope is dropped from the hashed payload when it is
  undefined, so `unidentified: 'share'` produces byte-identical keys to the ones this
  middleware produced before caller scoping existed: an external cache (Redis and friends)
  keeps every entry across the upgrade, and a test pins that. Deployments that adopt
  principals get new keys for newly-scoped requests, which is the point - the old unscoped
  entries are simply never read again rather than being served to somebody they do not belong
  to.

  Nothing here reintroduces a Node-only dependency: keys are still hashed with the pure-JS
  `stableHash` that #48 moved to, so the middleware keeps working in browsers, webviews and
  Electron renderers.

  **Why minor rather than patch.** Two reasons, either of which would be enough. New public
  API is added - `IRMetadata.principal`, `RequestOptions.principal`, `EmbedOptions.principal`,
  `CachingConfig.unidentified`, `EmbeddingCachingConfig.unidentified`, and a `cache-bypassed`
  member on `WarningCategory`. And a deployment that upgrades without reading anything sees
  its cache stop serving hits until it supplies a principal or opts into sharing. That is a
  behaviour change in the safe direction, but it is a behaviour change, and it should not
  arrive in a patch that reads as "no action required".

  A custom `keyGenerator` is unaffected: supplying one still takes over key derivation
  entirely, `scopeKey`, `principal` and `unidentified` are all bypassed, and the generator
  remains responsible for mixing in caller identity itself.

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

- eb8580b: Name middleware, so a failure says which one failed.

  `MiddlewareError.middlewareName` existed, was typed and documented, and never
  held a middleware name. The four sites that set it hardcoded the literal
  `'unknown'`; the two that actually wrap a middleware failure omitted it. A
  stack of eight middleware reported `Middleware execution failed: <message>`
  with no indication of which one broke - the one piece of provenance the wrapper
  exists to add was always either absent or a placeholder.

  The blocker was that `MiddlewareStack` entries carried no name, so naming
  middleware was the prerequisite.

  `use()` and `useStreaming()` - on both `MiddlewareStack` and `Bridge` - now
  take an optional second argument:

  ```ts
  bridge.use(createRetryMiddleware({ maxAttempts: 3 }), { name: 'retry' });
  ```

  and a failure reads:

  ```
  Middleware "retry" failed: connection reset
  ```

  The name is resolved at registration, in order:
  1. `options.name`;
  2. the function's own `.name` - free for `function rateLimit()` and for
     `const rateLimit = async (ctx, next) => ...`, and skipped when it carries no
     information (`middleware`, `handler`, `fn`, …);
  3. the registration position, `middleware[3]`.

  The position is the index across _both_ `use()` and `useStreaming()`, so the
  same middleware is named identically on the streaming and the non-streaming
  path. It is never `'unknown'`: a position is less useful than a name and far
  more useful than nothing. The four lock-guard errors now name the middleware
  being added or removed instead of claiming `'unknown'`, and report no name at
  all when the function is anonymous.

  Every middleware factory in `@johnhenry/aimatey-middleware` ends in
  `return async (context, next) => {…}`, which produces an anonymous function -
  so pass `{ name }` for anything built by one, or it can only be identified by
  position.

  **API addition, fully backward compatible.** The new parameter is optional;
  every existing `use(middleware)` and `useStreaming(middleware)` call keeps
  working unchanged, and `remove()`/`getMiddleware()` identity is unaffected.
  The only observable change is the wording of the failure message, which gained
  the middleware's name.

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

- 48c5c26: Fix `Bridge.getStats().backendUsage` attributing every success to the wrapper, and delete
  the `on()`/`once()` docs that denied events are emitted.

  **`backendUsage` now names the backend that actually served each request.** It was derived
  at read time as `{ [this.backend.metadata.name]: this._successfulRequests }`. `this.backend`
  is whatever the bridge was constructed with, so on a router-backed bridge that is the
  _router_: four requests round-robined across two registered backends reported
  `{ router: 4 }` instead of `{ cheap: 2, expensive: 2 }`. Per-backend usage - the only thing
  the field exists to report - was unobservable, and the workaround was to tally provenance
  by hand outside the bridge, which is what the round-robin example in the docs does.

  The count is now accumulated as requests succeed, keyed by the backend named in the
  response's resolved `provenance.backend`. That is the value #57 made report the adapter
  that answered rather than the bridge's wrapper, so this fix consumes that precedence rule
  rather than restating it: whatever the chain reported wins, and the bridge's own backend
  name is the fallback only when the adapter reported none. A router-backed bridge starts
  telling the truth; a single-backend bridge reports exactly what it always did.

  **The streaming path is fixed with it.** `chatStream()` increments the same success counter
  `chat()` does, so it was already contributing to `backendUsage` - all of it filed under the
  wrapper. Leaving it alone would have dropped streamed requests from the breakdown entirely.
  It now reports the backend named on the stream's enriched `start` chunk, read before the
  frontend conversion that discards IR metadata, so the two paths agree about who served a
  request and the per-backend counts sum to `successfulRequests`.

  `resetStats()` clears the breakdown along with the other counters.

  Two consequences worth stating. A backend that has served nothing since the last reset now
  has no key at all, where a fresh single-backend bridge previously reported its one backend
  with a count of `0`; a zero for a backend that never ran is the same class of falsehood
  being fixed here. And `backendUsage` now agrees with `provenance.backend` for an adapter
  whose reported name differs from its registered one, rather than with the bridge's
  configured name. Semantics are otherwise unchanged: it still counts successes only, so a
  failed request remains in `failedRequests` and `errorBreakdown`.

  **`on()` and `once()` no longer claim events are unimplemented.** Both carried
  "Event emission is not yet implemented. Listeners are stored for future use when event
  emission is added." Emission has been implemented for some time - `emit()` is called from
  seven sites. The note told anyone reading the JSDoc that the feature in front of them did
  not work, so the reasonable response was to go build a wrapper instead of using it.

  Replaced with what actually happens: six `BridgeEventType` values are emitted -
  `request:start`, `request:success` and `request:error` from `chat()`, and `stream:start`,
  `stream:complete` and `stream:error` from `chatStream()` - while `request:cancelled`,
  `stream:chunk`, `backend:selected`, `backend:failover` and `middleware:executed` are
  declared on the type but nothing emits them, so a listener for one of those never fires.
  The docs also now state that `executeIR()`/`executeIRStream()` are deliberately silent, and
  that a listener which throws is swallowed rather than failing the request. Tests pin each
  of those claims, so the docs cannot silently go stale again.

  Docs only for the second half - no behaviour changed there.

- 7be8792: Fix `Bridge` statistics drifting when a request failed before its execution pipeline ran.

  `_totalRequests` is incremented the moment a request arrives, but the work that happens
  before the retry loop - `frontend.toIR()`, request enrichment, and the registered-backend
  check enrichment performs - threw straight past the failure accounting. `getStats()` then
  reported a request that was counted as sent, never counted as failed, and produced no
  error event, so a caller computing `successRate` watched it drift downward with no failure
  to explain it, and anything listening for `REQUEST_ERROR` never learned the request died.

  Both `chat()` and `chatStream()` now run that pre-pipeline work inside the same accounting
  the rest of the method uses: `failedRequests` and the error breakdown are incremented, and
  a `REQUEST_ERROR` (or `STREAM_ERROR`, on the streaming path) event is emitted. The original
  error is re-thrown unchanged, so which error a caller sees is unaffected. When
  `frontend.toIR()` itself is what threw there is no IR request to report, so the event
  carries a stub with the generated request id and frontend provenance rather than being
  dropped.

  These are fail-fast programmer errors - a malformed request, an unknown backend name - and
  so are rare in a working integration, but they are exactly the errors worth an event while
  building one.

  `executeIR()` and `executeIRStream()` are deliberately left alone: they do not increment
  `totalRequests` either, so nothing skews. `getStats()` and the `REQUEST_*` events count
  `chat()` and `chatStream()` calls only, which means a `runTools()` loop reports as the one
  request the caller made rather than one per turn. That is now stated on both methods.

- 223c37a: Fix a router-backed `Bridge` being unobservable: `getRouter()` always returned `null`, and
  `enrichResponse()` overwrote which backend actually answered.

  **`Bridge.getRouter()` now returns the router.** It was hardcoded to `return null`, with a
  return type of the literal `null` rather than `Router | null` - so even the type said it
  could never work, while the `Bridge` interface in `@johnhenry/aimatey-types` had promised
  `Router | null` all along. There was no supported way to reach the router a bridge was
  constructed with: no inspecting `listBackends()`, no reading `getBackendInfo()`, no
  adjusting a fallback chain through the object you were handed. It now returns the
  configured backend when that backend is a `Router`, and `null` otherwise. The check is
  structural rather than an `instanceof`, so consumers do not pull the `Router`
  implementation in at runtime just to ask the question - this is the same duck-typing the
  private `asRouter()` added in #51 was doing, and that helper has been folded into
  `getRouter()` so there is one answer to the question instead of two.

  **Response provenance now names the backend that answered.** `enrichResponse()` set
  `provenance.backend` to `this.backend.metadata.name` unconditionally. For a router-backed
  bridge `this.backend` _is_ the router, so every response claimed `"router"`, discarding
  what the backend adapter had already written. For a multi-provider router - the case this
  library exists for - that field was always wrong, which matters for cost attribution, for
  debugging a bad answer, and for any UI showing where a reply came from.

  The precedence rule is now:
  - `provenance.frontend` is always the bridge's frontend adapter. The bridge knows this for
    certain.
  - `provenance.backend` keeps whatever the chain already reported, and only falls back to
    the bridge's own backend name when the adapter reported none. Every shipped backend
    adapter reports one, so in practice the routed backend wins.
  - `provenance.router` is set to the router's name on a router-backed bridge, using the
    field that already exists for it. The routing layer stays visible without overwriting
    the backend, so nothing that was learnable from the old (wrong) value is lost.

  **The streaming path now reports provenance too.** `chatStream()` and `executeIRStream()`
  applied no provenance at all, so the two paths disagreed about the same request:
  `chat()` always reported some backend while `chatStream()` reported only what the backend
  volunteered. The same rule is now applied to a stream's `start` chunk - the chunk backends
  carry response metadata on. Other chunks pass through untouched, and a `start` chunk
  carrying no metadata at all is left alone rather than given a fabricated one.

  Released as a patch: this is a bug fix in every direction. The widened `getRouter()` return
  type only brings the class in line with the `Bridge` interface it implements, which already
  declared `Router | null`, so no published type narrows and `@johnhenry/aimatey-types` is
  untouched. Callers reading `provenance.backend` on a single-adapter bridge see exactly what
  they saw before.

- 30629d4: Fix `MiddlewareContext.backend` and `.backendName` being documented but never populated.

  Both fields were declared and documented - "backend that will process (or processed) the
  request, available after routing decision" - and were `undefined` on every path, for every
  backend type. The bridge simply never set them.

  The cost is bigger than a missing field: **a middleware could not execute a turn of its
  own**, which rules out the whole class of middleware that needs a second pass - an agentic
  tool loop, retry with a modified request, failover. Middleware written against the
  documented type reads `context.backend` and guards with `if (!backend) …`; through a real
  `Bridge` that guard always fired. One consumer hit exactly this: the tool ran, the model
  never saw the result, and stripping the tool-call syntax left the user with an empty reply.
  Unit tests passed because a hand-built context had `backend` set, which is what the type
  invites. Middleware that merely _branches_ on `backendName` was hit more quietly - it took
  its fallback path every time, with no error.

  `Bridge` now populates both fields on all four paths (`chat`, `chatStream`, `executeIR`,
  `executeIRStream`), through new optional `backend` parameters on `createMiddlewareContext`
  and `createStreamingMiddlewareContext`.

  **Which backend they name.** The fields are seeded before the chain runs and narrowed once
  the routing decision resolves:
  - Before dispatch they are whatever the bridge is about to call. For a router-backed bridge
    that is the router, because the provider genuinely has not been chosen yet - and it is
    the useful value there, since executing through the router routes an extra turn the same
    way the original request was routed.
  - After a response comes back they are narrowed to the backend that actually served it,
    read from the response provenance the backend reports, with `backend` resolved through
    the router's registry so `backendName` always equals `backend.metadata.name`. On the
    streaming path the narrowing happens off the `start` chunk, early enough that the
    response phase of every middleware sees it.

  That is what "available after routing decision" describes, and it means a follow-up turn
  taken after `next()` goes to the backend that just answered - usually what a follow-up
  wants. To re-route deliberately, execute through `bridge.getRouter()` instead. Narrowing is
  driven from the bridge's innermost dispatch, so a middleware that calls `next()` more than
  once sees the value for its most recent dispatch rather than a stale one.

  Predicting the selected backend _before_ dispatch was considered and rejected: `Router`
  has no access to the middleware context (`BackendAdapter.execute()` takes only a request),
  and calling `Router.selectBackend()` up front would advance round-robin and re-roll random
  selection, so the context could name a backend other than the one that answered. Naming
  the router until the answer is known is honest; guessing is not.

  `backend` and `backendName` are no longer `readonly` on `MiddlewareContext`, since they are
  refined in place as the decision resolves. Dropping `readonly` does not affect assignability,
  so no existing implementation of the interface breaks.

  `createFailoverMiddleware()` in `@johnhenry/aimatey-patterns` is **not** affected: it takes
  its fallback adapters through `FailoverConfig.fallbacks` and never reads `context.backend`.
  It was already working, and keeps working.

- 9b31fc4: Fix `next()` called twice skipping the rest of the middleware chain.

  `MiddlewareStack.execute()` and `executeStream()` composed the chain with a
  single mutable `index` captured in the `next` closure, so a second `next()`
  advanced _past_ the next middleware instead of re-running the remainder of the
  chain:

  ```ts
  bridge.use(async (ctx, next) => {
    await next();
    return next(); // a retry
  });
  bridge.use(async (ctx, next) => next()); // ran once for two next() calls
  ```

  The second call went straight to the backend, so retry-shaped middleware
  retried with the unvalidated, untransformed request - the second attempt took a
  different code path from the first, silently, unless the retry happened to be
  registered last.

  Both paths now dispatch by recursion with the index as a parameter, so every
  `next()` re-enters at its own position and re-runs the whole remainder of the
  chain, in order, once per call.

  `next()` is deliberately left **re-entrant** rather than guarded the way Koa
  guards it. Koa throws on a second `next()` within one middleware; here
  retry-shaped middleware is a first-class pattern and a retry must re-run the
  validation, redaction and transform middleware registered after it, or the
  second attempt reaches the backend with a differently-prepared request.
  Re-running is not free of side effects - every downstream middleware runs
  again, `context` is shared rather than snapshotted, and nothing bounds the
  number of passes - and that is now documented on `execute()`, `executeStream()`
  and in `docs/api.md`.

  The one place a second `next()` is still refused is the streaming adapter added
  in #46/#50: once a standard middleware's first `next()` has handed a stream to
  the consumer, the chunks are already delivered and no restart could reach the
  consumer, so `adaptMiddlewareToStreaming` throws a `MiddlewareError` rather than
  start a stream nobody can read. A `next()` that _failed_ before any chunk was
  delivered is still retryable there, and such a retry now re-runs the whole
  downstream chain instead of skipping the middleware next to it. Stream-native
  middleware registered with `useStreaming()` owns the `IRChatStream` itself and
  may call `next()` as often as it likes.

  Error handling is unchanged: the innermost frame wraps a non-`MiddlewareError`
  into a `MiddlewareError`, outer frames re-throw it as-is, and the final handler
  is still called outside the `try`.

  Fixes #56.

- 8b89edb: Document two concurrency fixes that changed observable behaviour without a changelog entry,
  and pin both with tests that do not depend on timing (#36, #37).

  The code fixes landed in #45 but carried no changeset, so they were on course to be
  published as silent behaviour changes. Both alter what a caller observes, so both are
  recorded here.

  **`Router` "first success" parallel dispatch no longer settles on the first _failure_
  (#36).** `dispatchParallel({ strategy: 'first' })` awaited `Promise.race()` over per-backend
  promises that are wrapped to always fulfill - carrying `{ success: false, error }` when the
  backend threw - so the race returned whichever backend _settled_ first regardless of
  outcome. A backend that failed fast decided the result, and the dispatch threw
  `ALL_BACKENDS_FAILED` while a slower backend was still in flight and about to succeed.
  `fallbackParallel()` had the same defect through `Promise.race()` over the raw rejecting
  promises. That is the exact inverse of what "first success" promises, and it bit hardest in
  the case the strategy exists for: a fast-failing cheap backend paired with a slower reliable
  one.

  Both now race on fulfilment. `fallbackParallel()` uses `Promise.any()`; `dispatchParallel()`
  uses a `raceFirstSuccess()` helper, because its legs never reject and `Promise.any()` cannot
  see the `success` flag. `ALL_BACKENDS_FAILED` is now raised only once _every_ backend has
  failed, and names all of them rather than just the first to give up.

  What changes for callers: a parallel dispatch that used to fail can now succeed, and one
  that fails takes as long as its slowest backend rather than its fastest. Anything relying on
  a parallel dispatch failing fast will see it wait. `cancelOnFirstSuccess` still aborts the
  losing backends, but only on an actual success - a failure no longer cancels the field.

  **`splitStream()` no longer drops chunks produced before a split starts iterating (#37).**
  Each consumer's resolver defaulted to a no-op function. The eager producer treats a non-null
  resolver as "a consumer is parked waiting", so it handed chunks to that no-op and shifted
  them off the queue before any real consumer had begun. A split that started iterating even
  slightly late silently lost its prefix and then ended cleanly, so the loss looked like a
  short stream rather than an error. The sibling `teeStream()` had it right, defaulting to
  `null`; `splitStream()` now matches.

  The semantics this implies are now stated on the function rather than left to be discovered:
  **a split that subscribes late receives buffered history back to the stream's first chunk.**
  Splits are not live subscriptions. Draining one split fully before touching another is well
  defined and both see identical sequences. The alternative - treating a late first `next()` as
  an error - was rejected because a split exists to fan out to consumers whose start times the
  caller does not control, and there is no subscribe step to hook, only a first `next()`. The
  documented cost is memory: unread chunks are retained per split, so a split that is never
  iterated pins the whole stream.

  A dead `chunks` accumulator that appended every chunk and was never read has been removed
  alongside, so retention now matches what the documentation describes.

  Patch rather than minor in both cases: no API, option or type changed, and each is a bug fix
  restoring the behaviour the existing names and docs already promised.

- 582a4e5: Router: `clone()` keeps translation mappings, stats and circuit-breaker state (#58)

  `Router.clone()` copied `modelMapping`, `modelPatterns` and `fallbackChain` but
  not `modelTranslationMapping` or `backendTranslationMappings` — exactly the
  configuration that makes cross-provider fallback produce a valid request. A
  cloned router would fall back to a backend and send it a model name it had
  never heard of. Both are now copied, as independent maps.

  `clone()` also re-`register`ed each adapter, so every backend started fresh:
  request counts, latency samples and `totalCost` zeroed, and any **open circuit
  breaker silently closed**. Since `clone({ … })` reads like "same router,
  different config", cloning to change one option quietly re-armed a backend the
  breaker had just taken out of rotation.

  A clone is now documented, and implemented, as _this router with different
  settings_. It inherits:
  - **Routing configuration** — backend registrations in the same order, sharing
    the same adapter instances, plus the fallback chain, model mappings, model
    patterns, and the global and per-backend model translation mappings.
  - **Routing state** — the round-robin cursor, so a clone continues the rotation
    rather than restarting it.
  - **Accounting** — router-level and per-backend request counts, latency samples
    and `totalCost`, on the same reasoning as `replace()`: a cumulative record of
    traffic really sent and money really spent, which a configuration change does
    not un-spend.
  - **Health verdict** — `isHealthy`, `lastHealthCheck`, `consecutiveFailures`
    and the circuit-breaker state.

  That last point is where `clone()` deliberately differs from `replace()`, which
  _resets_ the health verdict. Both follow the same underlying rule: a health
  verdict survives exactly as long as the thing it judged. `replace()` swaps in a
  different adapter, so the verdict is stale by construction. `clone()` carries
  the _same adapter instances_ across, so an open circuit is still an accurate
  statement about them — and silently re-arming a backend the breaker had just
  removed, merely because the caller cloned to change an unrelated setting, is
  the more dangerous default.

  One exception: a clone that turns the circuit breaker **off** starts with every
  circuit closed. Nothing in such a router calls the breaker, so an inherited open
  circuit would never move back to half-open and the backend would be unroutable
  forever.

  Callers who want a genuinely fresh slate can follow the clone with
  `resetStats()` and `resetCircuitBreaker()`.

  Tests: `tests/unit/router-clone.test.ts` (16 cases).

- c06df51: Router: fail streamed requests over, and record their outcome (#54)

  `Router.executeStream()` never failed over. Where `execute()` called
  `executeFallback()`, the streaming path yielded an error chunk, so
  `fallbackStrategy`, `setFallbackChain()` and `customFallback` were all inert
  for streaming — the normal path for a chat app.

  It now fails over, bounded by what the consumer has already seen. Once model
  output has been handed over, no other backend can take the stream: restarting
  would duplicate or contradict text the user is already reading, so a failure
  from that point still surfaces as an `error` chunk. Before that point nothing
  is observable, so chunks that carry no model output (`start`, `metadata`) are
  held back and flushed the instant the first `content`, `tool_use` or `done`
  chunk arrives. The buffer never waits on a timer or a chunk count, so it adds
  nothing to time-to-first-token; it only defers chunks a consumer cannot render
  anyway. A backend that dies mid-preamble is replaced without the caller ever
  learning it existed. An `error` chunk that arrives before the stream has
  committed is treated exactly like a thrown error.

  Three consequences worth knowing:
  - Streaming fallback is always **sequential**, including under
    `fallbackStrategy: 'parallel'`. Racing streams would start N generations and
    abandon N-1 — billable output for no latency gain, since a stream can only be
    moved before its first token anyway.
  - An **aborted** request is never failed over: the caller asked to stop, not
    for a different backend.
  - At most 32 preamble chunks are held. A backend that emits more than that
    before its first token is malformed; rather than buffer without bound the
    router flushes, gives up the option to fail over, and streams through.

  `executeStreamOnBackend()` also counted a request without ever recording its
  outcome — `successfulRequests`, `failedRequests` and `latencies` were never
  touched and the circuit breaker was never consulted. So `successRate` decayed
  toward zero for any backend serving streamed traffic, the breaker never tripped
  on streaming failures nor reset on streaming successes, and latency-optimised
  routing was blind to streaming.

  The returned stream is now wrapped so its outcome reaches the same
  `recordSuccess` / `recordFailure` the non-streaming path uses (both extracted
  from `executeOnBackend`, whose behaviour is unchanged):
  - **Success** — a `done` chunk is seen, or the backend's iterator finishes
    without one. Counts a success, breaks the consecutive-failure run, takes a
    latency sample and accrues cost, and closes a half-open circuit.
  - **Failure** — the iterator throws, or yields an in-band `error` chunk. Counts
    a failure and may trip the breaker.
  - **Abandoned** — the consumer stops reading (`break`, `return()`, `throw()`,
    or an aborted request). Counted as a completed request without fault, because
    cancelling a stream must never be able to trip a circuit breaker on a backend
    that did nothing wrong. It contributes no latency sample and no cost estimate,
    and deliberately leaves `consecutiveFailures` and the breaker state untouched:
    a stream the consumer walked away from is not evidence that a suspect backend
    has recovered.

  The latency sample for a stream is full-response wall time — the same quantity
  `execute()` measures — so `averageLatencyMs` stays coherent for a backend
  serving both kinds of traffic. Time-to-first-token is a different, also useful
  metric; it would need its own field rather than being mixed into this one.

  `totalRequests` is now counted when the stream is first iterated rather than
  when it is created, so a stream that is created and discarded is not counted as
  sent. It was already counted after the circuit-breaker check, so a request the
  breaker refuses is still not counted.

  Tests: `tests/unit/router-streaming-fallback.test.ts` (24 cases).

- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [22b9273]
- Updated dependencies [32415cc]
- Updated dependencies [30629d4]
- Updated dependencies [f8d20bf]
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
  - @johnhenry/aimatey-errors@0.2.0

## 0.2.0

### Minor Changes

- 213b23e: Make a registered router backend reconfigurable: add `Router.replace()` and stop `unregister()`
  from refusing the default or the last backend.

  There was previously no way to change a backend's configuration once it was registered. The common
  case is a rotated API key: `register()` rejected a name that already existed, and `unregister()`
  refused to remove the default backend or the last remaining one, so both doors were closed at once.
  A single-backend router — the most common shape — was stuck with whatever adapter it was built with.

  **New: `Router.replace(name, adapter)`** (added to the `Router` interface in
  `@johnhenry/aimatey-types` and implemented in `@johnhenry/aimatey-core`)

  ```ts
  router.replace('openai', new OpenAIBackendAdapter({ apiKey: rotatedKey }));
  ```

  Swaps the adapter behind an existing name and keeps everything that refers to that backend _by
  name_: registration order, the fallback chain, model mappings, model patterns, and
  backend-specific translation mappings. An unregister/register round trip loses all of that, which
  is why it is not a substitute.

  `register()` deliberately stays strict rather than becoming an upsert — a duplicate name is almost
  always a double-initialization bug, and silently swapping the adapter would hide it. `replace()`
  correspondingly throws `ROUTING_FAILED` for a name that is _not_ registered; callers who want
  upsert semantics can write `router.has(n) ? router.replace(n, a) : router.register(n, a)`.

  State handling across a `replace()` is split deliberately:
  - **Carried over** — `totalRequests`, `successfulRequests`, `failedRequests`, `latencies`,
    `totalCost`. These are a cumulative accounting record of traffic sent to this logical backend.
    Zeroing `totalCost` on a credential change would silently corrupt spend tracking.
  - **Reset** — `isHealthy`, `circuitBreakerState`, `consecutiveFailures`, `circuitOpenedAt`,
    `lastHealthCheck`. These are a live judgement about a configuration that no longer exists.
    Keeping them would defeat the motivating use case: an expired key trips the circuit breaker, and
    a breaker left open would keep refusing the _new_, working key until `circuitBreakerTimeout`
    elapsed — or fail every request outright if this is the only backend.

  Follow `replace()` with `resetStats()` for a fully clean slate.

  **Changed: `Router.unregister()`**
  - The "cannot unregister last backend" guard is gone. Zero backends is a legitimate transient state
    — it is also the state of a freshly constructed `new Router()`, so the guard was not upholding an
    invariant that otherwise held. An app whose only provider was just disconnected is in exactly that
    state, and it now surfaces as a routing error on the next request rather than as a failure to
    remove the backend.
  - Unregistering the backend named by `config.defaultBackend` no longer throws. `defaultBackend` is
    cleared instead, and a `routing-config-changed` warning is emitted through
    `RouterConfig.onWarning` so the change is not silent.
  - Unregistering now also prunes every routing rule that named the removed backend: fallback-chain
    entries, model mappings, model patterns, and its backend-specific translation mapping. These were
    previously left dangling, violating the invariant that each `setFallbackChain` /
    `setModelMapping` / `setModelPatterns` / `setBackendTranslationMapping` call validates — and a
    later `register()` of a _different_ adapter under the same name silently inherited the removed
    backend's routing rules and translation mappings.
  - Unregistering a name that is not registered still throws `ROUTING_FAILED`.

  **Also new:** the `routing-config-changed` `WarningCategory` in `@johnhenry/aimatey-types`, for
  warnings about the router rewriting its own configuration (there is no request to attach these to,
  so `onWarning` is the only channel).

  Compatibility: removing a thrown error is not a breaking change for correct callers, but code that
  relied on `unregister()` throwing for the default or last backend will now see it succeed. Adding
  `replace()` to the `Router` interface is a breaking change only for third-party classes that
  `implement Router` directly.

### Patch Changes

- 6e79fa1: Fix `RequestOptions.backend` being silently ignored, so a request that explicitly asks for
  one provider is no longer served by another.

  `Router` reads its explicit-routing decision from `request.metadata.custom.backend`, but
  `Bridge.enrichRequest()` only ever merged `options.metadata` into that object - it never
  read `options.backend`. The documented per-request override was therefore inert on every
  path (`chat`, `chatStream`, `executeIR`, `executeIRStream`), while the undocumented
  `metadata.custom.backend` was the only mechanism that actually worked. A request asking
  for `{ backend: 'expensive' }` was answered by the router's `defaultBackend` with no error
  and no warning.

  `enrichRequest()` now folds `options.backend` into `metadata.custom.backend`. It is
  applied after `options.metadata`, so the typed, first-class option is authoritative over
  both a `metadata.custom.backend` already on the request and an untyped `backend` key
  passed through `options.metadata`. Omitting `options.backend` leaves an existing
  `metadata.custom.backend` untouched, so the pre-existing channel keeps working.

  **Unregistered backend names now fail fast.** `Router.selectBackend()` treats an
  unavailable preference as "fall through to strategy selection", which means a typo like
  `{ backend: 'antropic' }` also routed elsewhere in silence. For an explicit override that
  is the wrong behaviour, so the bridge now rejects a name the router has never had
  registered with an `AdapterError` carrying `ErrorCode.ROUTING_FAILED`, before any work is
  done. This is scoped deliberately:
  - Only _unregistered_ names are rejected. A backend that is registered but currently
    unhealthy or has an open circuit breaker is still handled by the router's fallback -
    that is what fallback is for.
  - Only the `options.backend` channel is affected. It was previously inert, so nothing can
    depend on its old behaviour. The lenient `metadata.custom.backend` channel is unchanged,
    to avoid breaking callers that rely on it under a non-`explicit` routing strategy.
  - On a bridge whose backend is a single adapter rather than a router there is no routing
    to override, so the option stays inert rather than throwing.

  Also documents the contract on `RequestOptions.backend`, and adds the previously
  undocumented `options` parameter of `chat()` / `chatStream()` to the Bridge API reference.

- 0ac4957: Fix middleware being silently skipped on every streaming request.

  `MiddlewareStack` kept two separate registries - `middleware` and
  `streamingMiddleware` - and `executeStream()` early-returned the backend stream
  whenever `streamingMiddleware` was empty. `Bridge.use()` only ever wrote to
  `middleware`, and `MiddlewareStack` was `private` on the Bridge, so
  `streamingMiddleware` was _always_ empty through the public API. Every
  middleware registered with `bridge.use()` - retry, caching, logging, telemetry,
  cost tracking, validation, security - ran for `chat()` and did nothing at all
  for `chatStream()`, while `getMiddleware()` kept reporting it as registered. For
  a chat app, where streaming is the normal path, that meant PII redaction and
  prompt-injection detection quietly never ran.

  **`bridge.use()` now runs on both paths.** The stack keeps one ordered
  registry and adapts each `Middleware` onto the stream via a new exported
  `adaptMiddlewareToStreaming()`, preserving the onion shape:
  - the request phase (before `await next()`) runs before the backend is called;
  - chunks pass straight through - no buffering, no added latency;
  - the response phase (after `await next()`) runs once the stream has been
    consumed, against a real `IRChatResponse` assembled from the delivered chunks,
    so logging, telemetry, cost tracking, caching and conversation history see
    genuine content, usage and finish reason rather than a stub.

  **Request rewrites now reach the backend.** `Bridge` called the backend with the
  request it had captured before the chain ran, so a middleware that reassigned
  `context.request` - `createValidationMiddleware`'s PII redaction and
  sanitization, `createTransformMiddleware`, `createSecurityMiddleware`,
  `createConversationHistoryMiddleware` - had its rewrite thrown away on _both_
  paths. `chat()`, `chatStream()`, `executeIR()` and `executeIRStream()` now read
  `context.request` when they call the backend.

  **New: `bridge.useStreaming(mw)`** for stream-native middleware that transforms
  chunks directly, plus `removeStreamingMiddleware()` and
  `getStreamingMiddleware()`. `createStreamingCostTrackingMiddleware()` -
  previously unreachable through `Bridge` at all - can now be registered.
  `use()` and `useStreaming()` registrations interleave in registration order.

  **Documented limitations of the adapted path** (a middleware that needs the
  assembled response cannot behave identically on a stream, and this does not
  pretend otherwise):
  - The chunks have already reached the consumer when the response phase runs, so
    **modifications a middleware makes to the assembled response are dropped**.
    The response is explicitly marked: `metadata.custom.assembledFromStream` is
    `true` and an `info`-severity `capability-unsupported` `IRWarning` states the
    drift. Use `useStreaming()` to change what the consumer sees.
  - Errors thrown _after_ `next()` surface while the consumer iterates the stream,
    not from the `chatStream()` call. Errors thrown _before_ `next()` propagate
    from `chatStream()` exactly as they do from `chat()`.
  - A middleware that short-circuits without calling `next()` (a cache hit) has
    its response replayed as a synthetic stream, with a `capability-unsupported`
    warning on the start chunk noting the chunk boundaries are synthetic.
  - A partially delivered stream cannot be restarted: a second `next()` call
    throws a `MiddlewareError` rather than silently advancing the chain.
  - A consumer that abandons the stream still runs the response phase, with a
    partial response whose `finishReason` is `cancelled`.

  `MiddlewareOptions.supportsStreaming` was left unused. It belongs to a
  `MiddlewareWithMetadata` builder that does not exist anywhere in the repo, and
  it is an opt-_in_ boolean - which would mean middleware defaults to being
  skipped on streams, the very bug being fixed. The opt-in that is actually
  needed is the opposite one, chunk-level control, and the `StreamingMiddleware`
  type plus `useStreaming()` already express it. The field's doc comment now says
  so.

  (#46)

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-types@0.2.0
  - @johnhenry/aimatey-errors@0.1.1
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
  - @johnhenry/aimatey-errors@0.1.0
  - @johnhenry/aimatey-types@0.1.0
  - @johnhenry/aimatey-utils@0.1.0

> Previously published as `aimatey-core`, last unscoped version `0.3.4`.

## 0.3.4

### Patch Changes

- 5b44733: July 23 2026 provider refresh, plus a real bug fix.

  **Bug fix (Anthropic)**: Claude Opus 4.7+ (including 4.8) and Claude Sonnet 5 return HTTP 400 if
  `temperature`/`top_p`/`top_k` are set to a non-default value. `AnthropicBackendAdapter` now omits
  these params for those models (new exported `supportsSamplingParams()` helper) and surfaces a
  `parameter-unsupported` `IRWarning` instead of forwarding a request that would be rejected.

  **Default model bumps** (all confirmed stale/deprecated against provider docs as of 2026-07-23):
  - OpenAI: `gpt-5-mini` → `gpt-5.6-terra` (the dated `gpt-5-mini-2025-08-07` snapshot is deprecated,
    shuts down 2026-12-11)
  - Anthropic: `claude-sonnet-4-5-20250929` → `claude-sonnet-5` (Anthropic's current default)
  - xAI: `grok-4.3` → `grok-4.5`
  - Moonshot: `moonshot-v1-8k` → `kimi-k3` (2.8T-param flagship, 1,048,576 context, native
    multimodal - `multiModal`/`maxContextTokens` updated accordingly)
  - Gemini: `gemini-2.0-flash-lite` → `gemini-3.6-flash`

  **Aggregator adapter defaults** (OpenRouter, Fireworks, Together AI route to many vendors' models
  rather than owning a single lineage - their defaults were verified directly against each
  platform's live catalog on 2026-07-23, not assumed):
  - OpenRouter: `anthropic/claude-3-haiku` → `anthropic/claude-haiku-4.5` (Claude 3 Haiku is retired
    on Anthropic's own API and EOL on Bedrock 2026-09-10; `anthropic/claude-haiku-4.5` confirmed
    live via OpenRouter's public `/api/v1/models` endpoint, pricing matches Anthropic's own rate
    exactly)
  - Fireworks AI: `accounts/fireworks/models/llama-v3p1-8b-instruct` →
    `accounts/fireworks/models/deepseek-v4-flash` (confirmed listed on fireworks.ai/models);
    `maxContextTokens` raised 128000 → 1000000 to match
  - Together AI: `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` → `deepseek-ai/DeepSeek-V4-Pro`
    (confirmed listed on together.ai/models); `maxContextTokens` raised 128000 → 1000000 to match

  **Registry additions** (`aimatey-utils`'s `MODEL_REGISTRY_SEED`): `gpt-5.6-sol/terra/luna`
  (marking the deprecated dated GPT-5/o3 snapshots - `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `o3` -
  `deprecated: true`), `claude-opus-4-8`, `claude-fable-5`, `grok-4.5`, `gemini-3.6-flash`,
  `gemini-3.5-flash-lite`, and a new Moonshot AI section (`kimi-k3`, pricing confirmed via
  OpenRouter's live catalog). Some pricing figures for other brand-new SKUs (Gemini 3.6
  Flash/3.5 Flash-Lite, Grok 4.5, Fable 5, Opus 4.8) are estimates flagged in code comments, not
  independently confirmed - override via `registerModels()` if you have exact numbers.

  **Capability inference** (`aimatey-core`): adds a `moonshot` family (`kimi`/`moonshot` name
  matching) so Kimi K3 and future Moonshot models get sensible capability defaults instead of
  falling through to nothing.

  **Known gaps, not addressed by this refresh** (see the research thread for detail): whether any
  new inference-speed/open-weight/regional LLM providers outside aimatey's current 24 are worth
  adding, and the state of MCP/agent-interop/computer-use/prompt-caching/batch-API standardization
  across providers - both remain open follow-up research, not confirmed non-issues.

- Updated dependencies [5b44733]
  - aimatey-utils@0.5.0

## 0.3.3

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
  - aimatey-errors@0.2.1
  - aimatey-types@0.5.1
  - aimatey-utils@0.4.2

## 0.3.2

### Patch Changes

- Streaming methods now check `AbortSignal` between chunks in Bridge, Router, and the chat wrapper,
  so aborting a request stops delivery promptly instead of draining the remaining stream. (#8)

## 0.3.1

### Patch Changes

- d9e1489: July 2026 provider refresh. DeepSeek: V4 generation (`deepseek-v4-flash`/`deepseek-v4-pro`, 1M
  context, 384K output) with image input enabled — the adapter now advertises `multiModal` and
  defaults to `deepseek-v4-flash`; `deepseek-chat`/`deepseek-reasoner` marked deprecated (provider
  retires them 2026-07-24). Registry adds `claude-sonnet-5` (1M context), `gemini-3.5-flash`,
  `gemini-3.1-pro-preview`, `grok-4.3`, `grok-4.20` variants, and `grok-build-0.1`; capability
  inference recognizes the claude-5 and deepseek-v4 families; xAI default model updated off the
  retired `grok-beta`.
- Updated dependencies [d9e1489]
  - aimatey-utils@0.4.0

## 0.3.0

### Minor Changes

- dae4d01: Embeddings support: `bridge.embed()` / `router.embed()` with batch chunking, dimension
  normalization, and an embed middleware chain; provider implementations for OpenAI, Mistral,
  Gemini, Cohere, Ollama, Together, Fireworks, DeepInfra, NVIDIA, and LM Studio; caching and
  cost-tracking embedding middleware.
- 2912b7d: Introduce a shared, data-driven model registry in `aimatey-utils` as the single source of truth
  for model metadata (pricing, context windows, capabilities, quality/latency). The registry ships
  with a mid-2026 seed (GPT-5.x/o-series, Claude 4.x, Gemini 2.5/3, Grok, current Mistral/DeepSeek,
  plus embedding models) and is runtime-extensible via `registerModels()` / `overrideModelPricing()`,
  with alias and longest-prefix fallback so new dated snapshots of known families still resolve.

  `aimatey-core`'s model-pricing API is now a thin delegate over the registry (no API break; legacy
  models keep their prices, marked `deprecated`). Capability inference recognizes current families.
  Cost-tracking middleware consults the registry before provider-level defaults. `useTokenCount`
  consults the registry for context windows. Backend default models updated:
  `claude-3-haiku-20240307` → `claude-sonnet-4-5-20250929` (Anthropic), `gpt-3.5-turbo` →
  `gpt-5-mini` (OpenAI) — note this changes behavior for requests that omit a model. `estimateCost()`
  on both backends now prices the actual requested model. Refreshed `deepseek-chat` pricing.

- 78731bb: Router emits `model-substituted` warnings (metadata + new `RouterConfig.onWarning` callback) when
  hybrid translation falls back to a backend default model. http.core gains a framework-agnostic
  `GenericRateLimiter`; `RouteMatcher.match()` accepts any structurally-compatible request.
- b7e2312: Tool-calling helpers (`extractToolCalls`, `createToolResultMessage`, `validateToolArgs`, ...)
  and an agentic loop: `bridge.runTools({ prompt, tools })` executes model-requested tools and
  feeds results back until completion. `bridge.executeIR()` exposes the IR pipeline directly.

### Patch Changes

- f227db2: Lint hardening: previously-unlinted packages (cli, react-\*) now pass the strict ESLint config;
  fixed floating/misused promises in React hooks and CLI, case-block declarations, and unused
  variables. require-await and no-redundant-type-constituents re-enabled repo-wide.
- aef9f4a: New `aimatey-patterns` package: complexity routing, parallel aggregation, failover middleware,
  cost optimization with budget windows, and batch processing. Router's `dispatchParallel` now
  actually honors the `fastest` strategy (previously returned the first-registered success).
- Updated dependencies [dae4d01]
- Updated dependencies [e7df1d0]
- Updated dependencies [2912b7d]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
- Updated dependencies [58ebc03]
  - aimatey-types@0.3.0
  - aimatey-utils@0.3.0
