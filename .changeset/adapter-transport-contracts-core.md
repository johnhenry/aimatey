---
"@johnhenry/aimatey-core": minor
---

`Bridge` now calls `BackendAdapter.cancel(requestId)` when the request's `AbortSignal` aborts during `chat`, `chatStream`, `executeIR` or `executeIRStream` (#121). `Router.embed()` and `Router.decide()` judge a backend by `discoverCapabilities()` when it has one, cached per adapter for `capabilityCacheDuration`, refreshed by a passing `checkHealth()`, falling back to static `metadata.capabilities` when discovery fails (#127). Adapters without either method behave exactly as before.
