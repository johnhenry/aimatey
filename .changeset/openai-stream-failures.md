---
'@johnhenry/aimatey-backend': patch
---

OpenAI-compatible streaming no longer hides failures. An in-stream `error` event, a malformed `data:` frame, or a body that ends with neither `finish_reason` nor `[DONE]` now ends the stream with an `error` chunk (`PROVIDER_ERROR`, `STREAM_PARSE_ERROR`, `STREAM_INTERRUPTED`) instead of a normal `done`. A final `data: [DONE]` with no trailing newline is also handled.
