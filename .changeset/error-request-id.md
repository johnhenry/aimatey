---
'@johnhenry/aimatey-errors': minor
'@johnhenry/aimatey-backend': minor
---

Keep the provider's request id on HTTP errors (#213). `createErrorFromHttpResponse` now puts the id from `x-request-id`, `request-id` (Anthropic), `x-amzn-requestid` / `x-amzn-request-id` (AWS), `x-ms-request-id` or `apim-request-id` (Azure) on `error.details.requestId`, and stream `error` chunks carry it in `error.details.requestId`. New `extractRequestId(headers)` export. Replicate's HTTP errors now also receive the response headers.
