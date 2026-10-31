---
'@johnhenry/aimatey-frontend': minor
'@johnhenry/aimatey-wrapper': patch
'@johnhenry/aimatey-cli': patch
---

OpenAI frontend: a failed stream no longer ends silently as if it had finished. An IR `error` chunk (or a stream that throws) now yields a final `{ error: { message, type, param, code } }` frame, the shape OpenAI-compatible servers send as `data: {"error": ...}` and that the OpenAI SDKs raise; nothing is emitted after it. An upstream OpenAI error's own `type`/`code` (from the IR error's `details`) are kept. `fromIRStream` now yields `OpenAIStreamEvent` (`OpenAIStreamChunk | OpenAIStreamError`); use the new `isOpenAIStreamError()` guard before reading `choices`. The OpenAI SDK wrapper raises the error frame as an `AdapterError` (`STREAM_ERROR`), and the CLI's `toOpenAIStream` is typed accordingly.
