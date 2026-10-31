---
'@johnhenry/aimatey-http-core': minor
'@johnhenry/aimatey-http': minor
---

Streams are now framed the way each API frames them, instead of always as SSE ending in `data: [DONE]`:

- Gemini `…:streamGenerateContent?alt=sse`: SSE `data:` lines, no `[DONE]`. Without `alt=sse` (and for `:generateContent`): one JSON array (`application/json`). A `:streamGenerateContent` URL streams with no `stream` field in the body, as Gemini clients send it.
- Ollama `/api/chat`, `/api/generate`: NDJSON (`application/x-ndjson`), one object per line, no `[DONE]`.
- OpenAI `/chat/completions` and every other path: unchanged (SSE ending in `data: [DONE]`).

Each API also decides *whether* to stream its own way, and the request handler now follows it: Ollama's `/api/chat` and `/api/generate` stream unless the body says `stream: false` (Ollama's default is `true`; previously a body without `stream` got one JSON response). For Gemini URLs (`…/models/{model}:generateContent` or `:streamGenerateContent`) the model named in the URL is put into the body as `model` when the body has none, so the Gemini frontend routes it.

http-core exports `createStreamFramer`, `detectStreamFraming`, `isGeminiStreamURL`, `geminiModelFromURL`, `requestWantsStream`, `streamHeaders` and the `StreamFraming` type. `GenericResponse.stream()` takes an optional second argument `{ framing }`, which the Node, Express, Fastify, Koa, Hono and Deno adapters honour; without it they behave as before.
