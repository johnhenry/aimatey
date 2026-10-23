---
'@johnhenry/aimatey-errors': minor
'@johnhenry/aimatey-backend': minor
'@johnhenry/aimatey-types': patch
---

HTTP failures keep what the provider said. `createErrorFromHttpResponse` now puts the provider's own message (parsed from the response body, credentials redacted) in `error.message` and on the new `error.providerMessage`, keeps the status on the new `error.statusCode` and the redacted body on `error.details.responseBody`, and accepts the response headers so `RateLimitError.retryAfter` (ms) is parsed from `Retry-After`/`retry-after-ms`. 400 stays a non-retryable `ValidationError`, 404/410 about a model is `UNSUPPORTED_MODEL`, 5xx stays retryable. Every backend adapter now rethrows any `AdapterError` unchanged instead of re-wrapping a 401/403/429/400 as a retryable `PROVIDER_ERROR` (retry middleware no longer retries a bad key), and a failed stream's `error` chunk carries `details` (`errorCode`, `retryable`, `statusCode`, `providerMessage`, `retryAfter`) (#193).
