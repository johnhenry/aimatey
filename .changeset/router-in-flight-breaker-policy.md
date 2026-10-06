---
"@johnhenry/aimatey-core": minor
"@johnhenry/aimatey-types": minor
---

Router: `unregister()` in-flight semantics (#117) and per-backend circuit-breaker policy (#128).

**`unregister(name, { drain })`.** `unregister()` is not cancellation. A call already handed to the backend runs to its natural end (`execute()` resolves, a stream keeps yielding); no new request is routed to the name; the recovery timer is cancelled. The router now counts calls per backend (`BackendInfo.inFlight`), and `{ drain: true | timeoutMs }` returns a `Promise<UnregisterResult>` (`{ drained, inFlight }`) that settles when they finish. The backend is still removed synchronously. Without `drain` the signature and chaining are unchanged. To stop delivery (revocation), abort with the call's `AbortSignal`; only the transport can guarantee that.

**`register(name, adapter, { circuitBreaker: { enabled?, threshold?, timeout? } })`.** Per-backend overrides of `enableCircuitBreaker` / `circuitBreakerThreshold` / `circuitBreakerTimeout`, which are now documented as defaults. Overrides survive `replace()` and `clone()`; `getBackendInfo()` reports the effective policy as `BackendInfo.circuitBreaker`. Invalid values (non-integer or non-positive threshold, negative timeout) throw `INVALID_PARAMETERS` before the backend is registered.

Breaking changes:

- **Late outcomes of an unregistered backend are no longer accounted.** Previously an in-flight call wrote its counters, latency and breaker verdict onto the detached state, where nothing could read them; a late failure could also open the breaker of a *different* backend registered under the same name afterwards. It now does neither.
- **`openCircuitBreaker(name, timeoutMs)` honours `timeoutMs` in full.** It used to rest for `min(timeoutMs, circuitBreakerTimeout)` because the elapsed-time check read only the router-wide timeout. A longer `timeoutMs` is no longer capped.
- **`BackendInfo` has two new required fields** (`circuitBreaker`, `inFlight`). Code that constructs a `BackendInfo` by hand, or implements the `Router` interface, must add them; `Router.register` and `Router.unregister` gain the overloads above.
