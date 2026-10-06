---
"@johnhenry/aimatey-middleware": minor
---

Add decision middleware for `bridge.useDecision()`, exported from the package root and from `@johnhenry/aimatey-middleware/decisions`:

- `createDecisionCachingMiddleware`: key is a hash of state, questions, images, model and `parameters.custom`; same caller-scoping (`metadata.principal` / `scopeKey` / `unidentified`) as chat caching; hits carry `metadata.custom.cacheHit`; responses with a `response-malformed`, `capability-emulated` or `capability-unsupported` warning are never cached.
- `createDecisionCostTrackingMiddleware`: `usage.cost`, else input/output tokens x registry pricing, else 0 with a warning log; same `onCost` / `CostStorage` / threshold interface as chat.
- `createDecisionRetryMiddleware`: the chat retry loop on `next(request)`; never retries a `ValidationError`.
- `createDecisionLoggingMiddleware` and `createDecisionOpenTelemetryMiddleware`: per-decision log / span with per-question type, value and confidence; `state` is redacted unless `logState: true`.
- `createDecisionValidationMiddleware`: request shape checks, `maxStateBytes`, and `validateDecisionResponse` with `strict` mode.

Chat internals were generalized to share code with them: `runWithRetry`, `resolvePricing`, `recordCost`, `resolveCacheScope`, `withBypassWarning`, `acquireTracer` and a few others are now exported (marked `@internal`), and `InMemoryCacheStorage` is generic over the cached value (default unchanged). Chat middleware behaviour is unchanged.
