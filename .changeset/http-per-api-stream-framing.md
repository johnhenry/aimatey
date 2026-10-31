---
'@johnhenry/aimatey-http-core': minor
'@johnhenry/aimatey-http': minor
---

Streams are now framed the way each API frames them, instead of always as SSE ending in `data: [DONE]`:

- Gemini `…:streamGenerateContent?alt=sse`: SSE `data:` lines, no `[DONE]`. Without `alt=sse` (and for `:generateContent`): one JSON array (`application/json`). A `:streamGenerateContent` URL streams with no `stream` field in the body, as Gemini clients send it.
- Ollama `/api/chat`, `/api/generate`: NDJSON (`application/x-ndjson`), one object per line, no `[DONE]`.
- OpenAI `/chat/completions` and every other path: unchanged (SSE ending in `data: [DONE]`).

http-core exports `createStreamFramer`, `detectStreamFraming`, `isGeminiStreamURL`, `streamHeaders` and the `StreamFraming` type. `GenericResponse.stream()` takes an optional second argument `{ framing }`, which the Node, Express, Fastify, Koa, Hono and Deno adapters honour; without it they behave as before.
