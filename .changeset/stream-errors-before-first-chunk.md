---
'@johnhenry/aimatey-types': minor
'@johnhenry/aimatey-core': minor
'@johnhenry/aimatey-http-core': minor
---

A streamed request that fails before anything was produced now gets a real HTTP error response instead of a `200` stream that carries an error frame:

- New `RequestOptions.throwBeforeFirstChunk` for `Bridge.chatStream()`: when the backend throws before its first chunk, or its first chunk is an IR `error` chunk, the call throws that error (code and status kept), as `chat()` does, instead of yielding the frontend's in-band error frame. Off by default, so direct `chatStream()` callers see no change. Failures after the first chunk are error frames either way.
- The HTTP request handler (Node, Express, Fastify, Koa, Hono, Deno) turns it on and waits for the first chunk before starting the stream, so a rate limit, bad key or unknown model is answered with its status (429, 401, ...) and the API's error body. The official SDKs then raise their typed errors (`RateLimitError` in `openai` and `@anthropic-ai/sdk`, `ApiError` with `status` in `@google/genai`, `ResponseError` with `status_code` in `ollama`).
