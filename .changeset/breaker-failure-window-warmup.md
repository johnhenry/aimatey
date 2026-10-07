---
"@johnhenry/aimatey-core": minor
"@johnhenry/aimatey-types": minor
"@johnhenry/aimatey-errors": patch
---

Circuit breaker shape (#173, follow-up to #128).

**Failure window.** `circuitBreaker.window` (ms; per backend via `register()`, or `RouterConfig.circuitBreakerWindow`) makes the breaker open when `threshold` failures occur *within* the window, whatever succeeded in between. Left unset it is exactly the old behaviour: `threshold` consecutive failures with no notion of time. A failed half-open probe reopens a windowed breaker immediately.

**Warm-up tolerance.** New `ErrorCode.MODEL_LOADING` (provider category, retryable): "this backend is warming up". The default `countAsFailure` predicate does not count it toward the breaker (it still shows in `failedRequests`). `circuitBreaker.countAsFailure?: (error) => boolean` replaces the default per backend; it receives the thrown value, or the `{ code, message }` of an in-band stream error chunk, and a throwing predicate counts the failure.

**Adapter-declared policy.** `AdapterMetadata.circuitBreaker?: { threshold?, timeout?, window?, countAsFailure? }` is the adapter's recommendation, resolved per field as `register()` option > adapter metadata > `RouterConfig`, and reported in `BackendInfo.circuitBreaker.source`. `enabled` is deliberately not adapter-settable. Invalid values throw `INVALID_PARAMETERS` from `register()`/`replace()`/the constructor.

Breaking changes:

- `BackendInfo.circuitBreaker` (`EffectiveCircuitBreakerPolicy`) gains `window`, `countAsFailure` and `source`; code that builds one by hand must add them.
- A backend reporting `MODEL_LOADING` no longer counts toward the breaker. Nothing in the library reported it before, so only adapters that opt in are affected.

**`unregister(name, { abort: true })`** (#174, option 3 of #117). The router now gives each call its own `AbortController`, linked to the caller's signal (so adapters receive a derived signal rather than the caller's own), and `abort: true` aborts every call in flight on that backend (chat, stream, embed, decide), calls `adapter.cancel?.(requestId, reason)` once for each, and hands the caller an `AbortError` without failing over. Can be combined with `drain`. Without `abort` nothing changes. `cancel()` is sent for revocation only, not for a caller's own abort.
